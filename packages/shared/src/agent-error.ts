/**
 * Wire-format for structured chat-agent errors (subtask 2f89ff).
 *
 * Why this exists: when the model loop throws, Think (`@cloudflare/think`)
 * surfaces only `error.message` to the client over WebSocket. There's
 * no native channel for an error code, retry hint, or context map. We
 * smuggle that structured payload inside the message itself, prefixed
 * by a sentinel line.
 *
 * Wire format:
 *   DATA_AGENT_ERROR\n{"code":"...","message":"...","details":{...}}
 *
 * Server side (`packages/chat-agent/src/rate-limits.ts`):
 *   throw new Error(encodeAgentError({ code, message, details }))
 *
 * Client side (`packages/web/src/lib/agent-error.ts`):
 *   decodeAgentError(rawMessage) → { code, message, details } | null
 *
 * The prefix is deliberately ugly+unique so it never collides with a
 * real error message. The first newline is the only separator the
 * decoder considers.
 */

export const AGENT_ERROR_PREFIX = "DATA_AGENT_ERROR\n" as const;

export interface AgentErrorPayload {
  /** Stable machine-readable code (e.g. `rate_limit_chat_daily`). */
  code: string;
  /** Human-readable summary, OK to show in dev consoles. */
  message: string;
  /**
   * Free-form extra context. Known keys for known codes, but the
   * decoder must tolerate arbitrary shapes — never crash a banner
   * because of a missing field.
   */
  details?: Record<string, unknown>;
}

/** Build the wire-format string. */
export function encodeAgentError(payload: AgentErrorPayload): string {
  return AGENT_ERROR_PREFIX + JSON.stringify(payload);
}

/**
 * Try to decode a string into a structured error. Returns `null` for
 * anything that isn't our envelope (vanilla `Error` from the AI SDK,
 * provider errors, network errors, etc.) — the caller should fall
 * back to a generic banner in that case.
 */
export function decodeAgentError(raw: unknown): AgentErrorPayload | null {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith(AGENT_ERROR_PREFIX)) return null;
  const tail = raw.slice(AGENT_ERROR_PREFIX.length);
  try {
    const parsed = JSON.parse(tail) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { code?: unknown }).code === "string" &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return parsed as AgentErrorPayload;
    }
    return null;
  } catch {
    return null;
  }
}
