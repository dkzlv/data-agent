/**
 * Per-chat connection to the user's BYO Postgres database.
 *
 * Flow on first call:
 *   1. Look up the chat in control-plane → tenantId + dbProfileId.
 *   2. Load the dbProfile (host/port/database/sslmode + encrypted creds).
 *   3. Decrypt `{ user, password }` with envelope encryption (AAD bound to
 *      tenantId|dbProfileId — defends against cross-tenant ciphertext swap).
 *   4. Open `postgres()` with conservative pool limits and ssl.
 *   5. Cache the handle on the agent instance for reuse across turns.
 *
 * Connections are NOT closed eagerly — the DO will hibernate within ~70s
 * of inactivity which tears the underlying network sockets anyway. We
 * reopen on the next call. If a chat changes its dbProfile, callers must
 * call `resetDataDb()` so the next call re-resolves.
 *
 * NOTE: this is the chat-agent's connection to the *user's* database
 * (the data plane). It is unrelated to the Drizzle handle we use for
 * the control-plane (Neon DB managed by us).
 */
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createDbClient, schema } from "@data-agent/db";
import { decryptCredentials, type EncryptedRecord } from "@data-agent/shared";
import { readSecret, type Env } from "./env";

export interface DataDbContext {
  /** Connection pool — reuse across queries within a turn. */
  sql: postgres.Sql;
  /** Profile metadata, useful for tool descriptions / audit log. */
  profile: {
    id: string;
    tenantId: string;
    name: string;
    host: string;
    port: number;
    database: string;
    sslmode: string;
  };
}

/** Cached data-db handle stashed on the agent instance. Exported so the
 *  agent class can declare its `_dataDb?: CachedHandle` field. */
export interface CachedHandle extends DataDbContext {
  /** Profile id this cached client is bound to — invalidate on chat profile swap. */
  profileId: string;
}

/**
 * Minimal contract these helpers need from a ChatAgent. Each helper takes
 * a getter for `env` so we don't bump into TypeScript's `protected` access
 * rules on the agent base class.
 */
export interface AgentLike {
  /** chat id — used as DO name. */
  name: string;
  /** Resolves the chat-agent worker env. */
  getEnv(): Env;
  /** In-memory cache slot for the data-db handle. */
  _dataDb?: CachedHandle;
}

interface ResolvedChatProfile {
  tenantId: string;
  profile: {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    sslmode: string;
    encryptedCredentials: Uint8Array;
    encryptedDek: Uint8Array;
    encryptionKeyVersion: number;
  };
}

async function resolveChatProfile(env: Env, chatId: string): Promise<ResolvedChatProfile> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 2 });
  try {
    const [chat] = await db
      .select({
        tenantId: schema.chat.tenantId,
        dbProfileId: schema.chat.dbProfileId,
      })
      .from(schema.chat)
      .where(eq(schema.chat.id, chatId))
      .limit(1);

    if (!chat) {
      throw new Error(`chat ${chatId} not found`);
    }
    if (!chat.dbProfileId) {
      throw new Error(
        `chat ${chatId} has no database connected — attach a profile in the chat settings`
      );
    }

    const [profile] = await db
      .select({
        id: schema.dbProfile.id,
        name: schema.dbProfile.name,
        host: schema.dbProfile.host,
        port: schema.dbProfile.port,
        database: schema.dbProfile.database,
        sslmode: schema.dbProfile.sslmode,
        encryptedCredentials: schema.dbProfile.encryptedCredentials,
        encryptedDek: schema.dbProfile.encryptedDek,
        encryptionKeyVersion: schema.dbProfile.encryptionKeyVersion,
      })
      .from(schema.dbProfile)
      .where(eq(schema.dbProfile.id, chat.dbProfileId))
      .limit(1);

    if (!profile) {
      throw new Error(`db profile ${chat.dbProfileId} not found`);
    }

    return { tenantId: chat.tenantId, profile };
  } finally {
    // Don't await — close in background so we don't slow the cold path.
    void client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Build a postgres.js connection string from a profile + decrypted creds.
 * We keep the components separate (vs storing a libpq URL) so the user can
 * see host/port/database in the UI without us decrypting.
 */
function buildConnectionString(
  host: string,
  port: number,
  database: string,
  sslmode: string,
  user: string,
  password: string
): string {
  const params = new URLSearchParams({ sslmode });
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?${params.toString()}`;
}

/**
 * Lazily build (and cache on the agent instance) the data-db connection.
 *
 * Throws if:
 *   - The chat has no `dbProfileId` attached (user must connect one first).
 *   - The profile can't be decrypted (key rotation / cross-tenant swap).
 *   - The Postgres connection itself fails to authenticate or reach the host.
 */
export async function getDataDb(agent: AgentLike): Promise<DataDbContext> {
  const cached = agent._dataDb;
  if (cached) return cached;

  const env = agent.getEnv();
  const { tenantId, profile } = await resolveChatProfile(env, agent.name);

  const masterKey = await readSecret(env.MASTER_ENCRYPTION_KEY);
  // Postgres.js returns `bytea` columns as Node Buffer objects. Buffers
  // *are* Uint8Arrays but their `.buffer` is shared (pool-allocated), which
  // can confuse WebCrypto if a downstream `.slice()` returns a view into
  // the pool rather than an isolated allocation. Normalize to fresh
  // Uint8Arrays so encryption-side / DO-side bytes are byte-for-byte
  // identical regardless of driver quirks.
  const credBytes = new Uint8Array(profile.encryptedCredentials);
  const dekBytes = new Uint8Array(profile.encryptedDek);
  const record: EncryptedRecord = {
    ciphertext: credBytes,
    encryptedDek: dekBytes,
    keyVersion: profile.encryptionKeyVersion,
  };
  const creds = (await decryptCredentials(masterKey, record, {
    tenantId,
    dbProfileId: profile.id,
  })) as { user?: unknown; password?: unknown };

  if (typeof creds.user !== "string" || typeof creds.password !== "string") {
    throw new Error("decrypted credentials missing user/password");
  }

  const connStr = buildConnectionString(
    profile.host,
    profile.port,
    profile.database,
    profile.sslmode,
    creds.user,
    creds.password
  );

  const sql = postgres(connStr, {
    max: 4, // chats are low-concurrency
    idle_timeout: 20,
    connect_timeout: 10,
    fetch_types: false, // skip startup roundtrip in Workers
    prepare: false, // Worker / Hyperdrive friendliness
    onnotice: () => {}, // silence Postgres NOTICE spam
  });

  const ctx: CachedHandle = {
    sql,
    profile: {
      id: profile.id,
      tenantId,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      sslmode: profile.sslmode,
    },
    profileId: profile.id,
  };
  agent._dataDb = ctx;
  return ctx;
}

/**
 * Force the next `getDataDb` call to re-resolve (e.g. after the user swaps
 * the chat's dbProfile or rotates credentials). Closes the existing pool.
 */
export async function resetDataDb(agent: AgentLike): Promise<void> {
  const cached = agent._dataDb;
  if (!cached) return;
  agent._dataDb = undefined;
  try {
    await cached.sql.end({ timeout: 2 });
  } catch {
    // best effort
  }
}
