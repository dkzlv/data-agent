/**
 * Audit-log writer for api-gateway (subtask d7943e/1dd311).
 *
 * Writes a row to `audit_log` using the per-request Drizzle handle.
 * Always called via `c.executionCtx.waitUntil(writeAudit(...))` so
 * the response is never blocked on the insert. We swallow errors
 * and emit a structured `audit.write_failed` log event (9fa055) — a
 * missing audit row is preferable to a failed user request, but we
 * still want operations to know it happened.
 */
import { schema, type Database } from "@data-agent/db";
import { logEvent, truncateMessage, type AuditEvent } from "@data-agent/shared";

export async function writeAudit(db: Database, event: AuditEvent): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      tenantId: event.tenantId,
      userId: event.userId ?? null,
      chatId: event.chatId ?? null,
      action: event.action,
      target: event.target ?? null,
      payload: event.payload ?? null,
    });
  } catch (err) {
    logEvent({
      event: "audit.write_failed",
      level: "error",
      source: "api-gateway",
      action: event.action,
      tenantId: event.tenantId,
      chatId: event.chatId ?? null,
      error: truncateMessage(err),
    });
  }
}
