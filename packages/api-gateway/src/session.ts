import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDbClient, schema, type Database } from "@data-agent/db";
import { createAuth } from "./auth";
import { readSecret, type Env } from "./env";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface RequestSession {
  user: SessionUser;
  /** Active tenant id. For v1 we auto-create a personal tenant per user. */
  tenantId: string;
  /** Drizzle handle scoped to this request — closed in waitUntil. */
  db: Database;
}

type Vars = { session: RequestSession };

/**
 * Resolve the request's session via Better Auth + ensure the user has
 * a tenant. Attaches `c.var.session` for downstream handlers.
 *
 * Personal-tenant model for v1: every user has exactly one tenant they
 * own. Multi-tenant invitations land in a future task.
 */
export function requireSession(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const auth = await createAuth(c.env, c.executionCtx);
    const sessionResult = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!sessionResult?.user) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    const dbUrl = await readSecret(c.env.CONTROL_PLANE_DB_URL);
    const { db, client } = createDbClient({ url: dbUrl });
    c.executionCtx.waitUntil(client.end({ timeout: 1 }).catch(() => {}));

    const tenantId = await ensurePersonalTenant(db, {
      id: sessionResult.user.id,
      email: sessionResult.user.email,
      name: sessionResult.user.name ?? sessionResult.user.email,
    });

    c.set("session", {
      user: {
        id: sessionResult.user.id,
        email: sessionResult.user.email,
        name: sessionResult.user.name ?? sessionResult.user.email,
      },
      tenantId,
      db,
    });
    await next();
  };
}

async function ensurePersonalTenant(db: Database, user: SessionUser): Promise<string> {
  // Existing membership?
  const existing = await db
    .select({ tenantId: schema.tenantMember.tenantId })
    .from(schema.tenantMember)
    .where(eq(schema.tenantMember.userId, user.id))
    .limit(1);
  if (existing[0]) return existing[0].tenantId;

  // First time — create a tenant the user owns + a member row.
  const [tenant] = await db
    .insert(schema.tenant)
    .values({
      name: `${user.name}'s workspace`,
      ownerUserId: user.id,
    })
    .returning({ id: schema.tenant.id });

  if (!tenant) throw new Error("failed to create personal tenant");

  await db.insert(schema.tenantMember).values({
    tenantId: tenant.id,
    userId: user.id,
    role: "owner",
  });

  return tenant.id;
}

/** Throw 403 if the user is not an owner/admin of the active tenant. */
export async function requireTenantAdmin(c: Context<{ Bindings: Env; Variables: Vars }>) {
  const session = c.var.session;
  const member = await session.db
    .select({ role: schema.tenantMember.role })
    .from(schema.tenantMember)
    .where(
      and(
        eq(schema.tenantMember.tenantId, session.tenantId),
        eq(schema.tenantMember.userId, session.user.id)
      )
    )
    .limit(1);
  if (!member[0]) throw new Error("not a tenant member");
  if (member[0].role === "member") throw new Error("requires admin");
}
