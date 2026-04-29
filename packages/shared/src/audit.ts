/**
 * Audit logging helper (subtask d7943e/1dd311).
 *
 * Writes a row to control-plane `audit_log`. Designed to be called
 * fire-and-forget — failures are logged but never block the calling
 * request, because dropping a request because we couldn't audit it
 * would be a worse user experience than a missing audit row (which
 * is itself an alertable event in observability).
 *
 * Action vocabulary (dot-namespaced, stable):
 *
 *   chat.create               — chat created
 *   chat.update               — chat title/dbProfile changed
 *   chat.archive              — chat archived
 *   chat.member.add           — member added to chat
 *   chat.member.remove        — member removed from chat
 *   db_profile.create         — db profile created
 *   db_profile.update         — db profile credentials/url updated
 *   db_profile.delete         — db profile soft-deleted
 *   turn.start                — LLM turn started for a chat
 *   turn.complete             — LLM turn finished (with token usage)
 *   turn.error                — LLM turn errored
 *   db.query                  — db.query tool invoked (sql hash + row count)
 *   artifact.write            — artifact persisted to DO
 *   artifact.read             — artifact downloaded via HTTP
 *
 * `payload` must be safe to store: never raw rows, never raw SQL
 * (hash only), never DB credentials. Caller is responsible for
 * redaction.
 */
export interface AuditEvent {
  tenantId: string;
  userId?: string | null;
  chatId?: string | null;
  action: string;
  /** Free-form target id (chat id, profile id, sql hash, etc.). */
  target?: string | null;
  /** JSON-safe summary; redacted by caller. */
  payload?: Record<string, unknown> | null;
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void> | void;
}

/**
 * Hash a SQL string into a short stable identifier so we can correlate
 * repeated executions of the same query across audit rows without
 * storing the raw SQL (which may contain literals like emails or PII).
 */
export async function hashSql(sql: string): Promise<string> {
  const enc = new TextEncoder().encode(sql.trim().replace(/\s+/g, " "));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex; // 16 bytes / 32 hex chars — collision-safe within a tenant
}

/** Trim a payload to keep audit rows bounded in size. */
export function safePayload(
  obj: Record<string, unknown> | null | undefined,
  maxLen = 4_000
): Record<string, unknown> | null {
  if (!obj) return null;
  try {
    const json = JSON.stringify(obj);
    if (json.length <= maxLen) return obj;
    return { _truncated: true, preview: json.slice(0, maxLen) };
  } catch {
    return { _unserializable: true };
  }
}
