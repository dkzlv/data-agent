/**
 * Client-side translator for chat-agent errors (subtask 2f89ff).
 *
 * The chat-agent throws `Error(encodeAgentError(...))` for anticipated
 * failure modes (rate limits, sandbox timeouts, SQL errors, auth).
 * Think's WebSocket protocol carries `error.message` to the client
 * verbatim; we decode and translate to a user-facing banner.
 *
 * For unknown codes (or vanilla errors) we fall back to a generic
 * "something went wrong" message — never leak raw stack-frame text
 * to the user; that's a debugging aid, not UI.
 */
import { decodeAgentError } from "@data-agent/shared";

export interface FriendlyError {
  /** Headline shown in the banner. */
  title: string;
  /** Optional sub-line with retry hint or extra context. */
  detail?: string;
  /**
   * Severity. We use this to pick colors and icons:
   *  - `info`: rate limits, expected throttles
   *  - `warn`: SQL errors, tool failures (turn salvageable)
   *  - `error`: auth/connection (turn dead)
   */
  severity: "info" | "warn" | "error";
}

/**
 * Format a Date as `HH:MM <local-tz>` for the retry hint, e.g.
 * `"14:23 GMT+2"`. We avoid full ISO timestamps because they read
 * like a programmer error rather than a friendly hint.
 */
function formatLocalTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // `Intl.DateTimeFormat` zone is more accurate than `toString()`
  // tz strings, which vary by browser.
  const tz = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return tz ? `${hh}:${mm} ${tz}` : `${hh}:${mm}`;
}

/**
 * Translate a raw Error message (or unknown value) into a banner-ready
 * `FriendlyError`. Returns `null` if the input is empty/undefined OR
 * if the "error" is actually a benign abort (user navigated away, WS
 * dropped mid-stream, server-side resume in progress) — the caller
 * hides the banner in that case.
 *
 * Why aborts shouldn't show a banner: the partial assistant message
 * is still persisted server-side, the resume protocol picks up where
 * we left off, and showing "Something went wrong" on what's actually
 * a graceful pause confuses users (they think the answer was lost
 * when in reality the server has it).
 */
export function toFriendlyError(raw: unknown): FriendlyError | null {
  if (raw == null) return null;

  // Suppress benign aborts (`AbortError` from the AI SDK's stream
  // controller, or a `DOMException` named `AbortError` from a
  // user-initiated cancel). The chat will reconnect via the agents
  // SDK's resume protocol; no banner needed.
  if (
    raw instanceof Error &&
    (raw.name === "AbortError" ||
      raw.message === "BodyStreamBuffer was aborted" ||
      raw.message.toLowerCase().includes("aborted"))
  ) {
    return null;
  }

  const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw);
  if (!message) return null;

  const decoded = decodeAgentError(message);
  if (decoded) return translateKnownCode(decoded);

  // Unknown / vanilla error. Keep generic so we never echo a stack
  // trace; the browser console still has the original.
  return {
    title: "Something went wrong",
    detail: "The assistant couldn't finish that turn. Please try again.",
    severity: "warn",
  };
}

function translateKnownCode(payload: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): FriendlyError {
  const { code, details } = payload;

  // Rate limit family — three windows, identical UX shape.
  if (code.startsWith("rate_limit_")) {
    const retryIso = details?.["retryAt"];
    let retryHint = "Please try again later.";
    if (typeof retryIso === "string") {
      const d = new Date(retryIso);
      if (!Number.isNaN(d.getTime())) {
        retryHint = `Try again after ${formatLocalTime(d)}.`;
      }
    }
    const cap = scopeLabel(code);
    return {
      title: `${cap} message limit reached`,
      detail: retryHint,
      severity: "info",
    };
  }

  // Anticipated mid-turn failures (extension points — strings are
  // public API for the chat-agent's error envelope).
  switch (code) {
    case "sandbox_timeout":
      return {
        title: "Tool ran out of time",
        detail:
          "The data-fetching step took longer than 30 seconds. Try a simpler query or add a tighter `WHERE`.",
        severity: "warn",
      };
    case "sql_forbidden":
      return {
        title: "That query isn't allowed",
        detail: "The agent can only run read-only `SELECT`s and `WITH` queries.",
        severity: "warn",
      };
    case "sql_timeout":
      return {
        title: "Database query timed out",
        detail: "Your DB took >25s to respond. Try a smaller scan.",
        severity: "warn",
      };
    case "auth_expired":
      return {
        title: "Session expired",
        detail: "Refresh the page and sign in again.",
        severity: "error",
      };
    default:
      // Known prefix, unknown code — show what we have.
      return {
        title: "The assistant hit an error",
        detail: payload.message,
        severity: "warn",
      };
  }
}

function scopeLabel(code: string): string {
  if (code.includes("chat")) return "Chat";
  if (code.includes("user")) return "User";
  if (code.includes("tenant")) return "Workspace";
  return "Daily";
}

/**
 * Decide whether to suppress a generic stream error banner because
 * the assistant actually produced a usable answer.
 *
 * Background — chat 3a76a225 (task bf7ab7): every turn audited as
 * `turn.complete status="completed"` server-side, the DO held full
 * assistant content, but the user saw a "couldn't finish that turn"
 * banner. Cause: a single `data.error: true` chunk over the WS
 * (provider blip / mid-stream warning) trips
 * `WebSocketChatTransport._createResumeStream` into terminating the
 * client-side stream, parking `chat.status` in `"error"` even after
 * the rest of the response has streamed in.
 *
 * Earlier this lived inline in ChatRoom and additionally gated on
 * `chatStatus === "ready"`. Removed that gate: when an error chunk
 * trips the transport, status stays at `"error"` indefinitely so the
 * gate never fires even though the message store reflects a fully
 * completed answer. Trusting the message-store shape is the safer
 * heuristic — known-code errors (rate limit, sandbox timeout, SQL)
 * are still preserved because we never suppress decoded ones.
 *
 * Pure function for unit testing — the React side just calls
 * `chat.clearError()` when this returns true.
 */
export interface UsableContentPart {
  type?: string;
  text?: string;
  state?: string;
}

export function shouldClearStaleError(args: {
  /** The error currently held by `useChat`. */
  error: { message?: string } | null | undefined;
  /**
   * Last assistant message in the chat, or null/undefined if the
   * conversation is empty / the latest is from the user.
   */
  lastAssistant: { role?: string; parts?: readonly UsableContentPart[] } | null | undefined;
}): boolean {
  const { error, lastAssistant } = args;
  if (!error) return false;

  // Decoded (server-thrown) errors carry a wire envelope. Those are
  // legitimate failures the user should see — never suppress.
  if (error.message && decodeAgentError(error.message)) return false;

  if (!lastAssistant || lastAssistant.role !== "assistant") return false;
  const parts = lastAssistant.parts ?? [];
  return parts.some((p) => {
    if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      return true;
    }
    // A completed tool call counts — a turn that fetched data and
    // emitted an artifact is a usable answer even without a wrap-up
    // text part.
    if (p.type?.startsWith("tool-") && p.state === "output-available") {
      return true;
    }
    return false;
  });
}
