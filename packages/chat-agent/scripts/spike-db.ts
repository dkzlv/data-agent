/**
 * Subtask 5ea868 spike: end-to-end Postgres connection test.
 *
 * Plan:
 *   1. Insert a tenant + db profile + chat into the control-plane.
 *      The profile points at the *control-plane* Neon database (we
 *      reuse it as a test target so we don't need to provision a
 *      separate Postgres for the spike). Encrypts creds with envelope
 *      encryption + the master key.
 *   2. Mint a chat token, connect to ChatAgent.
 *   3. Call `dataDbHealthcheck()` — expect `{ ok, serverTime, serverVersion }`.
 *   4. Cleanup (delete the test rows).
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/spike-db.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AgentClient } from "agents/client";
import { createDbClient, schema } from "@data-agent/db";
import { encryptCredentials, mintChatToken } from "@data-agent/shared";

function loadDevVar(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(new RegExp(`^${name}="?([^"\\n]+)"?`, "m"));
      if (m) return m[1]!;
    } catch {
      // try next
    }
  }
  throw new Error(`${name} not in env or .dev.vars`);
}

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const SIGNING_KEY = loadDevVar("INTERNAL_JWT_SIGNING_KEY");
const MASTER_KEY = loadDevVar("MASTER_ENCRYPTION_KEY");
const DB_URL = loadDevVar("CONTROL_PLANE_DB_URL");

// Parse the DB URL so we can reuse host/port/database/user/password.
const parsed = new URL(DB_URL);
const host = parsed.hostname;
const port = parsed.port ? Number(parsed.port) : 5432;
const database = parsed.pathname.replace(/^\//, "");
const sslmode = parsed.searchParams.get("sslmode") ?? "require";
const user = decodeURIComponent(parsed.username);
const password = decodeURIComponent(parsed.password);

const stamp = Date.now();
const TEST_USER_ID = `spike-user-${stamp}`;
const TEST_TENANT_ID = `spike-tenant-${stamp}`;
const TEST_PROFILE_ID = `spike-profile-${stamp}`;
const TEST_CHAT_ID = `spike-chat-${stamp}`;

interface RPC {
  dataDbHealthcheck(): Promise<{
    ok: boolean;
    profile: { id: string; name: string; database: string; host: string };
    serverTime: string;
    serverVersion: string;
  }>;
  dbToolsSmoke(): Promise<{
    introspect: { schemas: number; tables: number };
    query: { rowCount: number; firstRow: unknown };
  }>;
}

async function setup() {
  const { db, client } = createDbClient({ url: DB_URL, max: 2 });
  try {
    // Spike requires test fixtures; we'll only insert the strict minimum.
    await db.insert(schema.user).values({
      id: TEST_USER_ID,
      email: `${TEST_USER_ID}@spike.test`,
      emailVerified: true,
      name: "Spike",
    });
    await db.insert(schema.tenant).values({
      id: TEST_TENANT_ID,
      name: "Spike tenant",
      ownerUserId: TEST_USER_ID,
    });
    await db.insert(schema.tenantMember).values({
      tenantId: TEST_TENANT_ID,
      userId: TEST_USER_ID,
      role: "owner",
    });

    const enc = await encryptCredentials(
      MASTER_KEY,
      { user, password },
      {
        tenantId: TEST_TENANT_ID,
        dbProfileId: TEST_PROFILE_ID,
      }
    );

    await db.insert(schema.dbProfile).values({
      id: TEST_PROFILE_ID,
      tenantId: TEST_TENANT_ID,
      name: "spike target (control-plane Neon)",
      createdBy: TEST_USER_ID,
      kind: "postgres",
      host,
      port,
      database,
      sslmode,
      encryptedCredentials: enc.ciphertext,
      encryptedDek: enc.encryptedDek,
      encryptionKeyVersion: enc.keyVersion,
    });

    await db.insert(schema.chat).values({
      id: TEST_CHAT_ID,
      tenantId: TEST_TENANT_ID,
      title: "spike",
      dbProfileId: TEST_PROFILE_ID,
      createdBy: TEST_USER_ID,
    });
    await db.insert(schema.chatMember).values({
      chatId: TEST_CHAT_ID,
      userId: TEST_USER_ID,
      role: "owner",
    });
    console.log("  ✓ fixtures inserted: chat=" + TEST_CHAT_ID);
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function cleanup() {
  const { db, client } = createDbClient({ url: DB_URL, max: 2 });
  try {
    await db.delete(schema.chatMember).where(eq(schema.chatMember.chatId, TEST_CHAT_ID));
    await db.delete(schema.chat).where(eq(schema.chat.id, TEST_CHAT_ID));
    await db.delete(schema.dbProfile).where(eq(schema.dbProfile.id, TEST_PROFILE_ID));
    await db.delete(schema.tenantMember).where(eq(schema.tenantMember.userId, TEST_USER_ID));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TEST_TENANT_ID));
    await db.delete(schema.user).where(eq(schema.user.id, TEST_USER_ID));
    console.log("  ✓ cleanup complete");
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function withConnectedClient<T>(fn: (c: AgentClient<RPC>) => Promise<T>): Promise<T> {
  const token = await mintChatToken(SIGNING_KEY, {
    userId: TEST_USER_ID,
    chatId: TEST_CHAT_ID,
    tenantId: TEST_TENANT_ID,
  });
  const c = new AgentClient<RPC>({
    host: ENDPOINT,
    agent: "ChatAgent",
    name: TEST_CHAT_ID,
    query: { token },
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("connect timeout")), 10_000);
    c.addEventListener("open", () => {
      clearTimeout(t);
      res();
    });
    c.addEventListener("error", () => {
      clearTimeout(t);
      rej(new Error("ws error"));
    });
  });
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function main() {
  console.log(`spike-db: chat=${TEST_CHAT_ID}\n`);
  console.log("[1/4] Setting up control-plane fixtures…");
  await setup();
  try {
    console.log("\n[2/4] Calling ChatAgent.dataDbHealthcheck() …");
    const r = await withConnectedClient((c) => c.call("dataDbHealthcheck", []));
    console.log("  ✓ ok=" + r.ok);
    console.log("    profile :", r.profile);
    console.log("    server  :", r.serverTime, "/", r.serverVersion);

    if (!r.ok) throw new Error("healthcheck returned ok=false");
    if (!r.serverVersion.includes("PostgreSQL")) {
      throw new Error("unexpected server version: " + r.serverVersion);
    }
    if (Math.abs(Date.now() - new Date(r.serverTime).getTime()) > 30_000) {
      throw new Error("server time skew >30s — clock issue?");
    }

    console.log("\n[3/4] Calling ChatAgent.dbToolsSmoke() — introspect + query …");
    const tools = await withConnectedClient((c) => c.call("dbToolsSmoke", []));
    console.log(
      "  ✓ introspect: schemas=" + tools.introspect.schemas + " tables=" + tools.introspect.tables
    );
    console.log(
      "  ✓ query rowCount=" +
        tools.query.rowCount +
        " firstRow=" +
        JSON.stringify(tools.query.firstRow)
    );
    if (tools.introspect.tables < 1)
      throw new Error("introspect saw no tables — control-plane should have many");
    if (tools.query.rowCount !== 1) throw new Error("expected exactly 1 row from SELECT 1+1");
    const two = (tools.query.firstRow as { two?: unknown })?.two;
    if (two !== 2 && two !== "2")
      throw new Error("expected SELECT 1+1 → 2, got " + JSON.stringify(two));

    console.log("\n[4/4] Cleanup…");
  } finally {
    await cleanup();
  }
  console.log("\n✓ data-db connection + db.* tools work end-to-end");
}

main().catch(async (e) => {
  console.error("\n✗ spike-db failed:", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
