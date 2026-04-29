/**
 * Audit writer for chat-agent (subtask d7943e/1dd311).
 *
 * Differs from api-gateway's writer:
 *   - We don't have a per-request Drizzle handle; we open a tiny
 *     connection-pool (max=1) on demand and close it via waitUntil.
 *   - All audit calls are best-effort and never block the turn.
 *
 * Usage:
 *   ctx.waitUntil(auditFromAgent(env, {...}));
 */
import type { AuditEvent } from "@data-agent/shared";
import { readSecret, type Env } from "./env";

export async function auditFromAgent(env: Env, event: AuditEvent): Promise<void> {
  try {
    const { createDbClient, schema } = await import("@data-agent/db");
    const url = await readSecret(env.CONTROL_PLANE_DB_URL);
    const { db, client } = createDbClient({ url, max: 1 });
    try {
      await db.insert(schema.auditLog).values({
        tenantId: event.tenantId,
        userId: event.userId ?? null,
        chatId: event.chatId ?? null,
        action: event.action,
        target: event.target ?? null,
        payload: event.payload ?? null,
      });
    } finally {
      // Close eagerly — we'll be GC'd anyway, but a stuck pool leaves
      // a connection slot in Neon's quota.
      await client.end({ timeout: 1 }).catch(() => {});
    }
  } catch (err) {
    console.error("audit (chat-agent) write failed", { action: event.action, err });
  }
}
