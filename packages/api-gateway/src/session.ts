import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDbClient, schema, type Database } from "@data-agent/db";
import { encryptCredentials } from "@data-agent/shared";
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
    // Defer the connection close to a macrotask 5 s out — using
    // `Promise.resolve().then(() => client.end())` (or .end with a 1ms
    // timeout) closes on the very next microtask, **before** the
    // synchronous queries inside this middleware (and `next()`!)
    // have a chance to run. That manifests as
    //   "Failed query: select tenant_id from tenant_member ..."
    // because the postgres-js client tears down the underlying
    // socket while drizzle is still mid-roundtrip. Same fix as the
    // one applied in auth.ts.
    c.executionCtx.waitUntil(
      new Promise<void>((res) =>
        setTimeout(() => {
          client.end({ timeout: 1 }).catch(() => {});
          res();
        }, 5_000)
      )
    );

    const tenantId = await ensurePersonalTenant(c.env, db, {
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

async function ensurePersonalTenant(env: Env, db: Database, user: SessionUser): Promise<string> {
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

  // Seed a default sample db_profile so brand-new users land in a
  // ready-to-query state (subtask: starter dataset). Best-effort —
  // signup must never fail because we couldn't seed a fixture, so
  // wrap in try/catch and log on failure. Idempotent in practice
  // because we only run it on first-time tenant creation.
  await seedSampleDbProfile(env, db, tenant.id, user.id).catch((err) => {
    console.error("[seed] failed to provision sample db_profile", {
      tenantId: tenant.id,
      err: (err as Error).message,
    });
  });

  return tenant.id;
}

/**
 * Provision a read-only `db_profile` pointing at the shared "Neon
 * employees database" sample dataset for every new tenant. Same row
 * shape as `POST /api/db-profiles` would produce — name, host, port,
 * sslmode, encrypted user/password — so the frontend renders it
 * exactly like a user-added profile.
 *
 * The credentials live behind a `data_agent_ro` Postgres role with
 * `SELECT`-only privileges on the `employees` schema. Even if our
 * sandbox safety nets fail open, the database itself rejects writes.
 *
 * Connection details are deliberately hard-coded (not env vars) —
 * this is a literal, named "starter dataset" the product ships with,
 * not a tenant-configurable secret. Rotating the password requires a
 * code change and re-deploy.
 */
async function seedSampleDbProfile(
  env: Env,
  db: Database,
  tenantId: string,
  userId: string
): Promise<void> {
  const id = crypto.randomUUID();
  // The web frontend matches by this exact string to detect "this is
  // the demo DB" and render the welcome flow / prompt chips. If you
  // rename it, also update `SAMPLE_DB_NAME` in
  // `packages/web/src/lib/sample-db.ts` — there's no shared source.
  const SAMPLE = {
    name: "Sample: Neon employees DB",
    host: "ep-frosty-thunder-anxk37z3-pooler.c-6.us-east-1.aws.neon.tech",
    port: 5432,
    database: "neondb",
    sslmode: "require" as const,
    user: "data_agent_ro",
    password: "agentReadOnly_2026!",
  };

  const masterKey = await readSecret(env.MASTER_ENCRYPTION_KEY);
  const enc = await encryptCredentials(
    masterKey,
    { user: SAMPLE.user, password: SAMPLE.password },
    { tenantId, dbProfileId: id }
  );

  await db.insert(schema.dbProfile).values({
    id,
    tenantId,
    name: SAMPLE.name,
    createdBy: userId,
    kind: "postgres",
    host: SAMPLE.host,
    port: SAMPLE.port,
    database: SAMPLE.database,
    sslmode: SAMPLE.sslmode,
    encryptedCredentials: enc.ciphertext,
    encryptedDek: enc.encryptedDek,
    encryptionKeyVersion: enc.keyVersion,
    // Mark as already-tested so the UI shows it as healthy without an
    // immediate round-trip — the spike that loaded the data already
    // verified connectivity.
    lastTestedAt: new Date(),
    lastTestedStatus: "ok",
  });

  console.log("[seed] provisioned sample db_profile", {
    tenantId,
    dbProfileId: id,
    profileName: SAMPLE.name,
  });
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
