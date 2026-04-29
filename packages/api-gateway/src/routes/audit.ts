/**
 * Audit log read API (subtask d7943e/1dd311).
 *
 * Tenant admins can list recent audit events for their tenant.
 * Filterable by `chatId`, `action` prefix, and `since` (ISO date).
 * Pagination is opaque-cursor based on (createdAt, id) — we use
 * `before` because audit logs are read newest-first and grow
 * monotonically.
 *
 * The endpoint never returns rows from another tenant — every query
 * is scoped to `c.var.session.tenantId`.
 */
import { and, desc, eq, gte, like, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@data-agent/db";
import type { Env } from "../env";
import { requireSession, requireTenantAdmin, type RequestSession } from "../session";

type Vars = { session: RequestSession };

export const auditRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

auditRouter.use("*", requireSession());

const listQuerySchema = z.object({
  chatId: z.string().uuid().optional(),
  action: z.string().min(1).max(64).optional(),
  since: z.string().datetime().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

auditRouter.get("/", async (c) => {
  // Owner/admin only. We surface audit visibility behind admin to keep
  // tenant members from snooping on each other's actions until we have
  // proper RBAC.
  try {
    await requireTenantAdmin(c);
  } catch {
    return c.json({ error: "owner_only" }, 403);
  }

  const params = listQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!params.success) {
    return c.json({ error: "bad_request", issues: params.error.issues }, 400);
  }
  const { chatId, action, since, before, limit } = params.data;
  const { tenantId, db } = c.var.session;

  const conds = [eq(schema.auditLog.tenantId, tenantId)];
  if (chatId) conds.push(eq(schema.auditLog.chatId, chatId));
  if (action) conds.push(like(schema.auditLog.action, `${action}%`));
  if (since) conds.push(gte(schema.auditLog.createdAt, new Date(since)));
  if (before) {
    // Cursor: "<isoDate>__<id>" — strict less-than on the (createdAt, id) tuple.
    const [iso, id] = before.split("__");
    if (iso && id) {
      conds.push(
        or(
          lt(schema.auditLog.createdAt, new Date(iso)),
          and(eq(schema.auditLog.createdAt, new Date(iso)), lt(schema.auditLog.id, id))
        )!
      );
    }
  }

  const rows = await db
    .select({
      id: schema.auditLog.id,
      userId: schema.auditLog.userId,
      chatId: schema.auditLog.chatId,
      action: schema.auditLog.action,
      target: schema.auditLog.target,
      payload: schema.auditLog.payload,
      createdAt: schema.auditLog.createdAt,
    })
    .from(schema.auditLog)
    .where(and(...conds))
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    .limit(limit);

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && last ? `${last.createdAt.toISOString()}__${last.id}` : null;

  return c.json({ events: rows, nextCursor });
});
