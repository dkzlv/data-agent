/**
 * Resilience wrapper around `createCodeTool` from `@cloudflare/codemode/ai`.
 *
 * Two failure modes we've observed in production that this fixes:
 *
 *   1. **Sandbox throws → entire turn aborts.**
 *      `createCodeTool`'s execute() throws on any error inside the
 *      sandbox (unknown capability, runtime TypeError, SQL failure
 *      bubbling up, etc.). The AI SDK then surfaces it as a fatal
 *      tool error and the turn ends with the generic "Something went
 *      wrong" banner. The model never gets a chance to recover.
 *
 *      We instead catch the throw and return a structured
 *      `{ code, error }` payload. The model sees the error text in
 *      the next step's tool result, can read it like a stack trace,
 *      and adjust (e.g. "oh, `chart.histogram` doesn't exist — let
 *      me build a bar chart with binned data manually").
 *
 *   2. **Large tool results blow context / break the chat row.**
 *      The codemode result ships back to the model as JSON. A
 *      `db.query` returning 5,000 rows of 80 columns can serialize to
 *      hundreds of KiB. That destroys the next-turn input budget
 *      and inflates the persisted `cf_agent_chat_messages` row. We
 *      truncate any result whose JSON exceeds a configurable cap
 *      (default 5,000 chars), replacing it with a marker that tells
 *      the model the data was clipped and how to narrow.
 *
 * Both behaviors are deliberately *transparent*: the wrapper returns
 * the same `{ code, result, logs? }` shape the upstream tool does,
 * just with `result` possibly replaced and `error` added on failure.
 */
import type { Tool } from "ai";

export const DEFAULT_RESULT_CHAR_CAP = 5_000;

export interface CodemodeWrapOptions {
  /** Max JSON-stringified chars allowed in `result`. Default 5000. */
  maxResultChars?: number;
  /** Hook called on truncation / error so callers can log. */
  onEvent?: (event: CodemodeWrapEvent) => void;
  /**
   * Text prepended (with a separating blank line) to the upstream
   * `description` the AI SDK ships to the model as the tool's docs.
   *
   * Why prepend instead of replace: `createCodeTool` synthesizes the
   * description from the registered sub-tools (db.*, chart.*, etc.)
   * including their TypeScript declarations — the model needs that
   * to know what's callable. We just want to add a high-priority
   * directive at the *top* so it's the first thing the model sees
   * when it reads tool docs while planning a turn.
   *
   * Concrete win for chat `feca41d8`: the system prompt's
   * fenced-code example primed Kimi to emit the snippet as plain
   * assistant content (no `tool_calls` block) ~5-15% of the time.
   * Prepending a "USE THIS TOOL — never reply with code in plain
   * text" directive to the tool description gives the tool channel
   * an unambiguous voice that pushes back when prompt prose is
   * ambiguous.
   */
  descriptionPrepend?: string;
}

export type CodemodeWrapEvent =
  | { kind: "truncated"; originalChars: number; cap: number }
  | { kind: "sandbox_error"; message: string };

interface RawOutput {
  code?: string;
  result?: unknown;
  logs?: string[];
}

/**
 * Build the truncation marker. Kept as an object (not a string) so the
 * sandbox JSON shape stays object-valued — easier for the model to
 * pattern-match on `_truncated: true` than to parse a sentinel string.
 */
export function buildTruncatedMarker(
  originalChars: number,
  cap: number
): {
  _truncated: true;
  reason: string;
  originalChars: number;
  cap: number;
  hint: string;
} {
  return {
    _truncated: true,
    reason: "result exceeded size cap",
    originalChars,
    cap,
    hint:
      "Result was too large to return. Re-run with a tighter LIMIT, " +
      "fewer columns, or aggregate (COUNT, AVG, GROUP BY) before returning.",
  };
}

/**
 * Decide whether a result needs truncation. JSON-stringifies once and
 * returns the size + (optionally) a replacement payload. We do this in
 * a pure function so unit tests don't need a sandbox.
 */
export function maybeTruncateResult(
  result: unknown,
  cap: number
):
  | { value: unknown; truncated: false }
  | { value: unknown; truncated: true; originalChars: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    // Circular or non-serializable. Replace with a marker — the model
    // would have choked on it anyway when it tried to read fields.
    return {
      value: {
        _truncated: true,
        reason: "result not JSON-serializable",
        cap,
      },
      truncated: true,
      originalChars: -1,
    };
  }
  if (serialized === undefined) {
    // JSON.stringify returns undefined for undefined / functions.
    return { value: result, truncated: false };
  }
  if (serialized.length <= cap) return { value: result, truncated: false };
  return {
    value: buildTruncatedMarker(serialized.length, cap),
    truncated: true,
    originalChars: serialized.length,
  };
}

/**
 * Best-effort string extraction from an unknown thrown value. Mirrors
 * `truncateMessage` from @data-agent/shared but kept local so this
 * module has no cross-package import (easier to unit-test).
 */
function describeThrown(err: unknown, maxLen = 800): string {
  if (err == null) return "unknown error";
  if (err instanceof Error) {
    const msg = err.message ?? String(err);
    return msg.length > maxLen ? `${msg.slice(0, maxLen)}…` : msg;
  }
  if (typeof err === "string") {
    return err.length > maxLen ? `${err.slice(0, maxLen)}…` : err;
  }
  try {
    const s = JSON.stringify(err);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return "unknown error";
  }
}

/**
 * Wrap a codemode tool so its `execute` is resilient: sandbox errors
 * become structured results, oversized results get truncated.
 *
 * The input `Tool` is the value returned by `createCodeTool({...})`.
 * We only override `execute`; everything else (description,
 * inputSchema, etc.) passes through.
 */
export function wrapCodemodeTool<T extends Tool>(tool: T, options: CodemodeWrapOptions = {}): T {
  const cap = options.maxResultChars ?? DEFAULT_RESULT_CHAR_CAP;
  // Wrap the user-supplied onEvent so a buggy logger can never break
  // a turn. Mirrors the "audit failures never block a request"
  // convention used elsewhere in the codebase.
  const emit = options.onEvent
    ? (e: CodemodeWrapEvent) => {
        try {
          options.onEvent!(e);
        } catch {
          // swallow — the caller's logger is broken, not our problem
        }
      }
    : undefined;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK Tool's execute is heavily generic
  const original = (tool as any).execute as
    | ((input: unknown, ctx: unknown) => Promise<unknown>)
    | undefined;
  if (typeof original !== "function") {
    // No execute → nothing to wrap. Return as-is so we don't mask
    // upstream changes.
    return tool;
  }

  const wrapped = async (input: unknown, ctx: unknown): Promise<unknown> => {
    let raw: unknown;
    try {
      raw = await original(input, ctx);
    } catch (err) {
      // The AI SDK passes thrown errors back to the model as a
      // tool-error step, which Kimi K2.6 handles inconsistently
      // (sometimes recovers, often gives up). Returning a normal
      // result with an `error` field is more reliable: the next
      // step sees a plain object and the model adapts.
      const message = describeThrown(err);
      emit?.({ kind: "sandbox_error", message });
      // Try to preserve the user's `code` (input.code) in the output
      // so the message history shows what was attempted.
      const code = (input as { code?: unknown } | null | undefined)?.code;
      return {
        code: typeof code === "string" ? code : undefined,
        error: message,
        result: null,
        // Hint the model that this is recoverable, not a hard-stop.
        recoverable: true,
      };
    }

    // Codemode's success shape is { code, result, logs? }. Only the
    // `result` field can be huge (it carries db rows etc.). We
    // truncate just that, leaving code + logs intact.
    if (raw && typeof raw === "object" && "result" in raw) {
      const o = raw as RawOutput;
      const decision = maybeTruncateResult(o.result, cap);
      if (decision.truncated) {
        emit?.({
          kind: "truncated",
          originalChars: decision.originalChars,
          cap,
        });
        return { ...o, result: decision.value };
      }
    }
    return raw;
  };

  // Build a shallow clone so we don't mutate the original tool object.
  // Spread covers Tool's known fields; the cast back to T preserves
  // the AI SDK's branded type.
  const out: Record<string, unknown> = { ...(tool as object), execute: wrapped };
  if (options.descriptionPrepend) {
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK Tool types description as string | undefined
    const upstream = (tool as any).description;
    out.description =
      typeof upstream === "string" && upstream.length > 0
        ? `${options.descriptionPrepend}\n\n${upstream}`
        : options.descriptionPrepend;
  }
  return out as T;
}
