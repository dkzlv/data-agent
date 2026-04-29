/**
 * Audit-log writer for api-gateway (subtask d7943e/1dd311).
 *
 * Writes a row to `audit_log` using the per-request Drizzle handle.
 * Always called via `c.executionCtx.waitUntil(writeAudit(...))` so
 * the response is never blocked on the insert. We swallow errors and
 * `console.error` them — a missing audit row is preferable to a
 * failed user request, but we still want it to show up in logs.
 */
import { schema, type Database } from "@data-agent/db";
import type { AuditEvent } from "@data-agent/shared";

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
    // Do not throw — audit writes are best-effort.
    console.error("audit write failed", { action: event.action, err });
  }
}
