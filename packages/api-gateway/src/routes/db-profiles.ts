import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { z } from "zod";
import { schema } from "@data-agent/db";
import { encryptCredentials } from "@data-agent/shared";
import { readSecret, type Env } from "../env";
import { requireSession, type RequestSession } from "../session";

type Vars = { session: RequestSession };

const newProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1).max(128),
  user: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
  sslmode: z.enum(["disable", "require", "verify-ca", "verify-full"]).default("require"),
});

/** Try to open the postgres connection + run SELECT 1; close. */
async function testConnection(args: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const ssl =
    args.sslmode === "disable"
      ? false
      : args.sslmode === "require"
        ? "require"
        : args.sslmode === "verify-ca" || args.sslmode === "verify-full"
          ? { rejectUnauthorized: true }
          : "require";

  const client = postgres({
    host: args.host,
    port: args.port,
    database: args.database,
    user: args.user,
    password: args.password,
    ssl,
    max: 1,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 8,
  });
  try {
    const rows = await client`SELECT 1 AS ok`;
    if (rows[0]?.ok !== 1) {
      return { ok: false, error: "unexpected response from server" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

export const dbProfilesRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

dbProfilesRouter.use("*", requireSession());

// List
dbProfilesRouter.get("/", async (c) => {
  const { tenantId, db } = c.var.session;
  const rows = await db
    .select({
      id: schema.dbProfile.id,
      name: schema.dbProfile.name,
      host: schema.dbProfile.host,
      port: schema.dbProfile.port,
      database: schema.dbProfile.database,
      sslmode: schema.dbProfile.sslmode,
      lastTestedAt: schema.dbProfile.lastTestedAt,
      lastTestedStatus: schema.dbProfile.lastTestedStatus,
      lastTestedError: schema.dbProfile.lastTestedError,
      createdAt: schema.dbProfile.createdAt,
    })
    .from(schema.dbProfile)
    .where(and(eq(schema.dbProfile.tenantId, tenantId), isNull(schema.dbProfile.deletedAt)))
    .orderBy(desc(schema.dbProfile.createdAt));
  return c.json({ profiles: rows });
});

// Create
dbProfilesRouter.post("/", async (c) => {
  const { tenantId, user, db } = c.var.session;
  const body = newProfileSchema.parse(await c.req.json());

  // 1. Validate connection — fail fast if creds don't work.
  const test = await testConnection(body);
  if (!test.ok) {
    return c.json({ error: "connection_failed", message: test.error }, 400);
  }

  // 2. Allocate id, encrypt creds against tenant + profile id, insert.
  const id = crypto.randomUUID();
  const masterKey = await readSecret(c.env.MASTER_ENCRYPTION_KEY);
  const enc = await encryptCredentials(
    masterKey,
    { user: body.user, password: body.password },
    { tenantId, dbProfileId: id }
  );

  const [inserted] = await db
    .insert(schema.dbProfile)
    .values({
      id,
      tenantId,
      name: body.name,
      createdBy: user.id,
      kind: "postgres",
      host: body.host,
      port: body.port,
      database: body.database,
      sslmode: body.sslmode,
      encryptedCredentials: enc.ciphertext,
      encryptedDek: enc.encryptedDek,
      encryptionKeyVersion: enc.keyVersion,
      lastTestedAt: new Date(),
      lastTestedStatus: "ok",
    })
    .returning({
      id: schema.dbProfile.id,
      name: schema.dbProfile.name,
      host: schema.dbProfile.host,
      port: schema.dbProfile.port,
      database: schema.dbProfile.database,
      sslmode: schema.dbProfile.sslmode,
      lastTestedAt: schema.dbProfile.lastTestedAt,
      lastTestedStatus: schema.dbProfile.lastTestedStatus,
      createdAt: schema.dbProfile.createdAt,
    });

  // 3. Audit
  await db.insert(schema.auditLog).values({
    tenantId,
    userId: user.id,
    action: "db_profile.create",
    target: id,
    payload: { name: body.name, host: body.host, database: body.database },
  });

  return c.json({ profile: inserted }, 201);
});

// Re-test
dbProfilesRouter.post("/:id/test", async (c) => {
  const { tenantId, db } = c.var.session;
  const id = c.req.param("id");

  const [row] = await db
    .select()
    .from(schema.dbProfile)
    .where(
      and(
        eq(schema.dbProfile.id, id),
        eq(schema.dbProfile.tenantId, tenantId),
        isNull(schema.dbProfile.deletedAt)
      )
    )
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);

  // Decrypt creds, test, update status; never return creds in response.
  const { decryptCredentials } = await import("@data-agent/shared");
  const masterKey = await readSecret(c.env.MASTER_ENCRYPTION_KEY);
  // Normalize Buffer→Uint8Array (postgres.js returns bytea as Node Buffer
  // whose underlying ArrayBuffer is pool-allocated; copying into a fresh
  // Uint8Array isolates the bytes for WebCrypto). Same fix applied in
  // chat-agent/data-db.ts.
  const creds = (await decryptCredentials(
    masterKey,
    {
      ciphertext: new Uint8Array(row.encryptedCredentials as Uint8Array),
      encryptedDek: new Uint8Array(row.encryptedDek as Uint8Array),
      keyVersion: row.encryptionKeyVersion,
    },
    { tenantId, dbProfileId: id }
  )) as { user: string; password: string };

  const test = await testConnection({
    host: row.host,
    port: row.port,
    database: row.database,
    user: creds.user,
    password: creds.password,
    sslmode: row.sslmode,
  });

  await db
    .update(schema.dbProfile)
    .set({
      lastTestedAt: new Date(),
      lastTestedStatus: test.ok ? "ok" : "failed",
      lastTestedError: test.ok ? null : test.error.slice(0, 500),
    })
    .where(eq(schema.dbProfile.id, id));

  return c.json({ ok: test.ok, error: test.ok ? null : test.error });
});

// Soft-delete
dbProfilesRouter.delete("/:id", async (c) => {
  const { tenantId, user, db } = c.var.session;
  const id = c.req.param("id");

  const result = await db
    .update(schema.dbProfile)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(schema.dbProfile.id, id),
        eq(schema.dbProfile.tenantId, tenantId),
        isNull(schema.dbProfile.deletedAt)
      )
    )
    .returning({ id: schema.dbProfile.id });

  if (result.length === 0) return c.json({ error: "not_found" }, 404);

  await db.insert(schema.auditLog).values({
    tenantId,
    userId: user.id,
    action: "db_profile.delete",
    target: id,
  });

  return c.json({ ok: true });
});
