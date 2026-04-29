/**
 * Auto-generate a chat title from the first user message (subtask 16656a).
 *
 * Strategy:
 *   - Reuse Workers AI + the same model the chat itself runs on (Kimi
 *     K2.6 by default). Avoids a second model dependency, gets the same
 *     gateway cost-tracking surface, and keeps the response under a
 *     second on the happy path.
 *   - Single short prompt asking for 3-6 words, title case. Output is
 *     sanitized hard (strip quotes, leading "Title:", trailing
 *     punctuation, collapse whitespace) — model output is messy and we
 *     don't want a quote mark leaking into the chat list.
 *   - Persist via a control-plane Drizzle connection guarded by
 *     `WHERE title_auto_generated = true AND title = 'New chat'` so a
 *     manual rename in flight wins over us.
 *   - Fire-and-forget from `agent.ts` `beforeTurn` via `waitUntil`.
 *     Same pattern as audit writes; no queue needed.
 *
 * Failure modes (all recoverable, all silent to the user):
 *   - Model returns garbage / sanitation rejects → leave default,
 *     log `chat.title_summarize_failed`.
 *   - Race lost (user PATCHed first) → no rows updated, log + skip.
 *   - DB / network blip → caught + logged.
 */

import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { logEvent, safePayload, truncateMessage } from "@data-agent/shared";
import { auditFromAgent } from "./audit";
import { readSecret, type Env } from "./env";

/**
 * Title-call model override (task 0cc87b, fallback step 1B).
 *
 * We tried to keep the title call on the same model the chat itself
 * uses, but Kimi K2.6's Workers AI binding ignores
 * `chat_template_kwargs.enable_thinking: false` — the spike
 * (`scripts/spike-title.ts`) returned outputChars=0,
 * reasoningChars=241, all 64 output tokens consumed by reasoning
 * before any visible title text. Empty raw → sanitize_rejected →
 * chat list stayed at "New chat".
 *
 * Overriding to a small non-thinking llama gives us:
 *   - deterministic visible-text output (no reasoning surface)
 *   - cheaper than running the chat model for a 3-6 word task
 *   - decoupled from chat-model swaps (gpt-oss / kimi / glm) so a
 *     future model change doesn't silently break titles
 *
 * This means the AI-Gateway metadata `model` field on the title call
 * intentionally diverges from `opts.modelId` (the chat model) — the
 * `kind: "title-summary"` label still buckets these correctly in the
 * gateway dashboard.
 */
const TITLE_MODEL_OVERRIDE = "@cf/meta/llama-3.1-8b-instruct" as const;

/**
 * System prompt — exported for tests so we can lock in the literal
 * (small change here = noticeable shift in title quality).
 */
export const TITLE_SUMMARY_SYSTEM_PROMPT =
  'Generate a concise 3-6 word title for a chat that begins with the user message below. Output ONLY the title — no quotes, no punctuation at the end, no "Title:" prefix, no markdown. Title case.';

/** Hard cap on the prompt input — same order of magnitude as a tweet
 *  but not so small that we lose context for long composer messages. */
const MAX_INPUT_CHARS = 1500;

/**
 * Sanitize raw model output into a safe title.
 *
 * Returns `null` when output is unsalvageable (empty, too short/long
 * after cleanup) — caller treats null as a failure and logs it.
 *
 * Pure function (no env / no IO) so it's trivially unit-testable.
 */
export function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // The model can wrap the prefix inside the quotes ("Title: ...") so
  // we run quote-strip + prefix-strip + trailing-punct in a loop until
  // stable; each pass removes one layer.
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201C", "\u201D"], // curly double
    ["\u2018", "\u2019"], // curly single
  ];
  for (let i = 0; i < 4; i++) {
    const before = s;
    // Strip a leading "Title:" / "title:" / "# " prefix.
    s = s.replace(/^(?:title\s*:\s*|#\s+)/i, "").trim();
    // Drop a single matched pair of wrapping quotes / backticks.
    for (const [open, close] of quotePairs) {
      if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) {
        s = s.slice(open.length, -close.length).trim();
        break;
      }
    }
    // Strip any trailing punctuation the model adds despite instructions.
    s = s.replace(/[.!?:;,]+$/u, "").trim();
    if (s === before) break;
  }

  // Collapse internal whitespace runs (newlines, tabs, multiple spaces).
  s = s.replace(/\s+/g, " ");

  if (!s) return null;

  // Word-count guardrail. Single-word "Untitled" or 9+ word essays
  // both indicate the model didn't follow instructions — fall through
  // to failure so the default sticks.
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return null;

  // Defensive char cap — never write a 200-char title to the column.
  // Truncate at the last whole word boundary so we don't end on
  // half a word.
  const MAX_CHARS = 80;
  if (s.length > MAX_CHARS) {
    const cut = s.slice(0, MAX_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    s = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  }

  return s || null;
}

/**
 * Walk a UIMessage's `parts[]` and concat all `text` parts. Skips
 * tool-call/result/reasoning/etc. — we only want what the user
 * literally typed. Truncated to {@link MAX_INPUT_CHARS}.
 *
 * Tolerant of unknown shapes: the @cloudflare/think `Message` type is
 * nominally `UIMessage`, but the actual runtime shape can drift across
 * SDK versions, so we treat parts as `unknown[]` and look up by
 * duck-typed `type === "text"`.
 */
export function extractFirstUserText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") chunks.push(p.text);
  }
  if (chunks.length === 0) return null;
  let joined = chunks.join("\n").trim();
  if (joined.length === 0) return null;
  if (joined.length > MAX_INPUT_CHARS) joined = joined.slice(0, MAX_INPUT_CHARS);
  return joined;
}

/**
 * Inputs for `maybeScheduleTitleSummary`. Kept separate from
 * `SummarizeOpts` because the trigger gate doesn't need the model id,
 * gateway, broadcast etc — those are only needed if we *do* schedule.
 */
export interface TriggerInputs {
  chatId: string;
  tenantId: string | null;
  /** True if we've already scheduled in this DO instance. */
  alreadyScheduled: boolean;
  /** The persisted message list so we can detect "first user message". */
  messages: unknown[];
}

export type TriggerResult =
  | { scheduled: false; reason: "already_scheduled" | "tenant_unresolved" | "not_first_turn" }
  | { scheduled: false; reason: "no_text" | "text_too_short"; textLen: number }
  | { scheduled: true; userMessageText: string };

/**
 * Pure decision helper for the auto-title trigger (subtask 16656a).
 *
 * Returns whether the caller should kick off `summarizeAndPersistTitle`
 * and (when not) why it skipped. The agent uses the result to:
 *   - flip `_titleSummaryScheduled` only when we actually schedule
 *   - log `chat.title_summarize_skipped` for diagnostic skip reasons
 *
 * Trigger gates (matching the pre-extraction semantics exactly):
 *   - Per-DO `alreadyScheduled` flag stops re-fires on resume/reconnect.
 *   - We only run on the FIRST user message — `userMsgs.length === 1`.
 *     Think persists the just-arrived user message before `beforeTurn`
 *     runs, so on the first turn we expect exactly 1.
 *   - Skip when tenantId is unresolved (the persist step needs it).
 *   - 4-char minimum on the user message so a stray "hi" / "?" /
 *     blank doesn't burn a model call on garbage.
 */
export function maybeScheduleTitleSummary(inputs: TriggerInputs): TriggerResult {
  if (inputs.alreadyScheduled) {
    return { scheduled: false, reason: "already_scheduled" };
  }
  if (!inputs.tenantId) {
    return { scheduled: false, reason: "tenant_unresolved" };
  }
  const userMsgs = Array.isArray(inputs.messages)
    ? inputs.messages.filter((m) => (m as { role?: string }).role === "user")
    : [];
  if (userMsgs.length !== 1) {
    return { scheduled: false, reason: "not_first_turn" };
  }
  const text = extractFirstUserText(userMsgs[0]);
  if (!text) {
    return { scheduled: false, reason: "no_text", textLen: 0 };
  }
  const trimmed = text.trim();
  if (trimmed.length < 4) {
    return { scheduled: false, reason: "text_too_short", textLen: text.length };
  }
  return { scheduled: true, userMessageText: text };
}

export interface SummarizeOpts {
  chatId: string;
  tenantId: string;
  userId: string | null;
  userMessageText: string;
  modelId: string;
  /** AI Gateway id (env.AI_GATEWAY_ID). When null, calls go direct. */
  gatewayId: string | null;
  /**
   * Send a payload to all connected WebSocket clients of the
   * chat-agent DO. Used to push the new title without a refetch.
   */
  broadcast: (msg: string) => void;
  /** Optional callback fired with the new title on success. Used by the
   *  agent to update its own cached chat-context so the next system
   *  prompt reflects the renamed chat without a control-plane round-trip. */
  onApplied?: (title: string) => void;
}

/**
 * End-to-end: call the model, sanitize, persist (race-guarded),
 * broadcast, audit. All errors are caught + logged; never throws.
 */
export async function summarizeAndPersistTitle(env: Env, opts: SummarizeOpts): Promise<void> {
  const startedAt = Date.now();

  logEvent({
    event: "chat.title_summarize_start",
    chatId: opts.chatId,
    tenantId: opts.tenantId,
    userId: opts.userId,
    model: opts.modelId,
    inputChars: opts.userMessageText.length,
  });

  let rawTitle: string | null = null;
  let outputTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let outputChars: number = 0;
  let reasoningChars: number | null = null;
  try {
    const workersai = createWorkersAI({ binding: env.AI });
    const gateway = opts.gatewayId
      ? {
          id: opts.gatewayId,
          metadata: {
            tenantId: opts.tenantId,
            chatId: opts.chatId,
            userId: opts.userId ?? "unknown",
            // Records the model we ACTUALLY called (override), not
            // the chat model. Chat model is still observable via the
            // `kind: title-summary` filter + the `chat.title_*` log
            // events which carry `opts.modelId`.
            model: TITLE_MODEL_OVERRIDE,
            // Bucket title-summary calls separately from main chat
            // turns so AI-Gateway dashboards can split the cost.
            kind: "title-summary",
          },
        }
      : undefined;

    // Override: see TITLE_MODEL_OVERRIDE doc — Kimi K2.6 binding
    // ignores enable_thinking:false, so we route titles to a small
    // non-thinking model regardless of the chat model.
    const model = workersai(TITLE_MODEL_OVERRIDE, gateway ? { gateway } : {});

    const result = await generateText({
      model,
      system: TITLE_SUMMARY_SYSTEM_PROMPT,
      prompt: opts.userMessageText,
      temperature: 0.3,
      // Bumped from 24 → 64 so the model has room to produce a 3-6
      // word title even after a few BPE quirks, and as cheap
      // insurance against stray reasoning tokens if the runtime
      // ignores `enable_thinking:false`. Sanitize caps word count
      // regardless.
      maxOutputTokens: 64,
    });
    rawTitle = result.text;
    const usage = (
      result as {
        usage?: { outputTokens?: number; reasoningTokens?: number };
      }
    ).usage;
    if (usage && typeof usage.outputTokens === "number") outputTokens = usage.outputTokens;
    if (usage && typeof usage.reasoningTokens === "number") {
      reasoningTokens = usage.reasoningTokens;
    }
    outputChars = (rawTitle ?? "").length;
    const reasoningTextLen = (result as { reasoningText?: string }).reasoningText?.length;
    if (typeof reasoningTextLen === "number") reasoningChars = reasoningTextLen;
  } catch (err) {
    logEvent({
      event: "chat.title_summarize_failed",
      level: "warn",
      chatId: opts.chatId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      model: opts.modelId,
      durationMs: Date.now() - startedAt,
      reason: "model_call_failed",
      error: truncateMessage(err),
    });
    return;
  }

  const sanitized = sanitizeTitle(rawTitle);
  if (!sanitized) {
    logEvent({
      event: "chat.title_summarize_failed",
      level: "warn",
      chatId: opts.chatId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      model: opts.modelId,
      durationMs: Date.now() - startedAt,
      reason: "sanitize_rejected",
      // 240 (was 120) — titles are tiny so this is for diagnosis,
      // not noise. We need the full picture when the sanitizer
      // rejects to tell "model returned junk" from "model returned
      // empty because reasoning ate the budget".
      rawPreview: (rawTitle ?? "").slice(0, 240),
      outputChars,
      reasoningChars,
      outputTokens,
      reasoningTokens,
    });
    return;
  }

  // Persist + race-guard. We open a fresh max=1 connection (mirrors
  // resolveChatContext / checkRateLimits) and close it eagerly.
  const { createDbClient } = await import("@data-agent/db");
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  let updatedRow: { id: string; title: string } | undefined;
  try {
    const { schema } = await import("@data-agent/db");
    const { and, eq } = await import("drizzle-orm");
    const result = await db
      .update(schema.chat)
      .set({ title: sanitized, updatedAt: new Date() })
      // The race-guard: if the user PATCHed in the meantime,
      // `title_auto_generated` is now `false` (api-gateway flips it on
      // every manual rename) and 0 rows update — we silently back off.
      // We also re-check `title = 'New chat'` so a previous summary
      // run isn't double-overwritten.
      .where(
        and(
          eq(schema.chat.id, opts.chatId),
          eq(schema.chat.titleAutoGenerated, true),
          eq(schema.chat.title, "New chat")
        )
      )
      .returning({ id: schema.chat.id, title: schema.chat.title });
    updatedRow = result[0];
  } catch (err) {
    logEvent({
      event: "chat.title_summarize_failed",
      level: "warn",
      chatId: opts.chatId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      model: opts.modelId,
      durationMs: Date.now() - startedAt,
      reason: "persist_failed",
      error: truncateMessage(err),
    });
    // Eagerly close the pool to avoid a stuck connection slot.
    await client.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // Close in the background; we don't need to block on it.
  void client.end({ timeout: 1 }).catch(() => {});

  if (!updatedRow) {
    // Race lost — user renamed the chat between our model call and
    // our UPDATE. This is the expected outcome whenever a human is
    // typing a title in parallel; not noisy enough to be `warn`.
    logEvent({
      event: "chat.title_summarize_failed",
      level: "info",
      chatId: opts.chatId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      model: opts.modelId,
      durationMs: Date.now() - startedAt,
      reason: "race_lost",
    });
    return;
  }

  // Broadcast to every WS connection on this chat so the UI updates
  // without an HTTP refetch. Stable type name `data_agent_title` — the
  // web client listens for it next to `data_agent_presence`.
  try {
    opts.broadcast(
      JSON.stringify({
        type: "data_agent_title",
        chatId: opts.chatId,
        title: sanitized,
      })
    );
  } catch {
    // Broadcasting is best-effort; if the DO has no live conns it's a
    // no-op anyway. The next page load will show the fresh title.
  }

  // Mirror onto the agent's cached chat-context so the next system
  // prompt reflects the new title without a control-plane round-trip.
  opts.onApplied?.(sanitized);

  const durationMs = Date.now() - startedAt;

  // Audit row — separate action so dashboards can slice "auto-titled"
  // vs. "manually-titled" chats.
  await auditFromAgent(env, {
    tenantId: opts.tenantId,
    chatId: opts.chatId,
    userId: opts.userId ?? null,
    action: "chat.title.auto",
    target: opts.chatId,
    payload: safePayload(
      {
        title: sanitized,
        model: opts.modelId,
        durationMs,
        inputChars: opts.userMessageText.length,
        outputTokens,
      },
      1024
    ),
  });

  logEvent({
    event: "chat.title_summarized",
    chatId: opts.chatId,
    tenantId: opts.tenantId,
    userId: opts.userId,
    model: opts.modelId,
    durationMs,
    title: sanitized,
    outputChars,
    reasoningChars,
    outputTokens,
    reasoningTokens,
  });
}

/**
 * Inputs for `scheduleTitleSummary`. Combines the trigger-gate inputs
 * with the run-time deps the actual model+persist call needs.
 *
 * Kept as a flat object (not nested) so callers don't construct
 * intermediate values they have to keep in sync.
 */
export interface ScheduleInputs {
  env: Env;
  chatId: string;
  tenantId: string | null;
  /** True if we've already scheduled in this DO instance. */
  alreadyScheduled: boolean;
  /** The persisted message list, used to detect "first user message". */
  messages: unknown[];
  userId: string | null;
  modelId: string;
  gatewayId: string | null;
  broadcast: (msg: string) => void;
  onApplied?: (title: string) => void;
  /** waitUntil-compatible callback so the caller (the agent) can
   *  ensure the model call survives the hook returning. */
  waitUntil: (p: Promise<unknown>) => void;
  /** Bound logger for skip-reason diagnostics. We intentionally do
   *  NOT log the expected "already_scheduled" / "not_first_turn"
   *  skips — those would be noise on every 2nd+ turn of every chat. */
  logSkip: (reason: "no_text" | "text_too_short" | "tenant_unresolved", textLen?: number) => void;
}

/**
 * Decide whether to kick off a title summary, schedule it (via
 * waitUntil) if so, and otherwise emit a skip-reason diagnostic
 * for the cases that warrant one.
 *
 * Returns whether scheduling happened so the caller can flip its
 * once-per-DO flag. Pure-ish: no IO done synchronously; the model
 * call is fired into the caller's `waitUntil`.
 */
export function scheduleTitleSummary(inputs: ScheduleInputs): { scheduled: boolean } {
  const result = maybeScheduleTitleSummary({
    chatId: inputs.chatId,
    tenantId: inputs.tenantId,
    alreadyScheduled: inputs.alreadyScheduled,
    messages: inputs.messages,
  });

  if (result.scheduled) {
    inputs.waitUntil(
      summarizeAndPersistTitle(inputs.env, {
        chatId: inputs.chatId,
        tenantId: inputs.tenantId!, // gate above guarantees non-null
        userId: inputs.userId,
        userMessageText: result.userMessageText,
        modelId: inputs.modelId,
        gatewayId: inputs.gatewayId,
        broadcast: inputs.broadcast,
        onApplied: inputs.onApplied,
      }).catch(() => {
        // Belt-and-braces: summarizeAndPersistTitle catches its own
        // errors and logs them. This guards against a sneaky throw
        // escaping the function (e.g. a TypeError during arg parse).
      })
    );
    return { scheduled: true };
  }

  switch (result.reason) {
    case "no_text":
    case "text_too_short":
      inputs.logSkip(result.reason, result.textLen);
      break;
    case "tenant_unresolved":
      // Only log when not already scheduled — otherwise we'd log on
      // every turn of an un-resolvable chat. (`alreadyScheduled` is
      // separately gated above.)
      inputs.logSkip("tenant_unresolved");
      break;
    // already_scheduled / not_first_turn → expected, no log.
  }
  return { scheduled: false };
}
