/**
 * Structured observability (subtask 9fa055).
 *
 * Every important code path emits a single-line JSON event via
 * `logEvent`. Cloudflare Workers Logs ingests `console.log` output
 * verbatim — when the line is valid JSON, the dashboard parses it
 * and lets us filter by any field. So our convention is:
 *
 *   console.log(JSON.stringify({ ts, level, event, ...fields }))
 *
 * Why a single field-name (`event`)? Predictable filtering. Every
 * span has a stable name (e.g. `api.request`, `chat.turn`,
 * `chat.tool_call`, `audit.write_failed`) you can pin to a saved
 * Logs query.
 *
 * What we DON'T do here:
 *   - sample logs (Logs Engine handles that at the platform level)
 *   - batch (each event is independent; loss-of-one is fine)
 *   - rotate or buffer (Workers stdout is the transport)
 *
 * Forensic hygiene:
 *   - Never log raw SQL (use `hashSql()` from audit.ts).
 *   - Never log full DB-profile credentials, tokens, secrets.
 *   - Truncate user content at 200 chars; full text lives in audit.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  /** Stable event name, kebab.dotted (e.g. `api.request`, `chat.turn`). */
  event: string;
  level?: LogLevel;
  /** Free-form structured fields. Keep keys camelCase. */
  [key: string]: unknown;
}

/**
 * Emit a structured log event. Defaults to `info`. Adds `ts`
 * (ISO timestamp) and `level` if missing. Always synchronous —
 * Workers stdout is fire-and-forget.
 *
 * Routes by level so dashboard severity filters work:
 *   - debug → console.debug
 *   - info  → console.log
 *   - warn  → console.warn
 *   - error → console.error
 */
export function logEvent(payload: LogEvent): void {
  let level: LogLevel = payload.level ?? "info";
  const line = {
    ts: new Date().toISOString(),
    level,
    ...payload,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(line);
  } catch {
    // Circular ref or non-serializable. Fall back to event name only;
    // bump level to `warn` so the dropped payload is visible in
    // dashboard severity filters. Never throw from a logger.
    level = "warn";
    serialized = JSON.stringify({
      ts: line.ts,
      level,
      event: payload.event,
      note: "log_payload_unserializable",
    });
  }
  switch (level) {
    case "debug":
      console.debug(serialized);
      break;
    case "warn":
      console.warn(serialized);
      break;
    case "error":
      console.error(serialized);
      break;
    default:
      console.log(serialized);
  }
}

/**
 * Span helper: time a block, emit one event when it finishes.
 *
 * Usage:
 *   const result = await withSpan("chat.turn", { chatId, userId }, async () => {
 *     return doTurn();
 *   });
 *
 * Records:
 *   - durationMs (always)
 *   - status: "ok" | "error" (always)
 *   - error: error.message (if thrown)
 *
 * Re-throws after logging so callers handle the failure as usual.
 */
export async function withSpan<T>(
  event: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T> | T
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logEvent({
      event,
      ...fields,
      durationMs: Date.now() - startedAt,
      status: "ok",
    });
    return result;
  } catch (err) {
    logEvent({
      event,
      level: "error",
      ...fields,
      durationMs: Date.now() - startedAt,
      status: "error",
      error: truncateMessage(err),
    });
    throw err;
  }
}

/** Truncate any error to a short, log-safe string. */
export function truncateMessage(err: unknown, max = 240): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}
