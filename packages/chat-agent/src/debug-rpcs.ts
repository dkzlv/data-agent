/**
 * Debug + smoke-test RPC bodies. The ChatAgent class keeps thin
 * `@callable()` stubs that delegate here, so the production class
 * stays focused on the Think lifecycle.
 *
 * Why functions, not a mixin:
 *   `@callable()` decorators must live on methods of the DO class
 *   itself for the agents SDK to discover them. A delegating one-liner
 *   stub is the obvious mechanical separation: no decorator gymnastics,
 *   no `this`-typing trouble, and the *implementation* moves out.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";
import { truncateMessage } from "@data-agent/shared";
import type { ChatContext } from "./system-prompt";
import { getDataDb, resetDataDb } from "./data-db";
import { artifactTools, chartTools } from "./tools/artifact-tools";
import { dbTools } from "./tools/db-tools";
import { type RateLimitDecision, runRateLimitCheck } from "./rate-limits";
import type { AgentHost } from "./agent-host";
import { embedText } from "./memory/embed";
import { hydrateFacts, persistFact, softDeleteFact } from "./memory/store";
import { queryVectors, upsertVector } from "./memory/vectorize";
import { retrieveMemory } from "./memory/retrieve";

/**
 * Re-export so call sites that imported `DebugRpcHost` from this
 * module continue to compile during the AgentHost migration.
 *
 * @deprecated import `AgentHost` from `./agent-host` directly.
 */
export type DebugRpcHost = AgentHost;

export async function healthcheck(host: DebugRpcHost): Promise<{
  ok: true;
  agent: string;
  chatId: string;
  time: string;
}> {
  return {
    ok: true,
    agent: "ChatAgent",
    chatId: host.name,
    time: new Date().toISOString(),
  };
}

/**
 * Wipe the persisted message history for this chat. Use to recover
 * from a stuck/corrupted assistant message (e.g. the model crashed
 * mid-stream and left a `state: streaming` part). The client UI
 * replays from this DO's SQL on every reconnect, so after this call a
 * fresh WS connect shows an empty chat.
 */
export async function debugClearMessages(
  host: DebugRpcHost
): Promise<{ ok: true; removed: number }> {
  const before = host.getPersistedMessages();
  host.clearPersistedMessages();
  return { ok: true, removed: before.length };
}

export async function debugRateLimits(host: DebugRpcHost): Promise<{
  ok: boolean;
  decision: RateLimitDecision | { ok: false; code: "no_chat_context" };
  tenantId: string | null;
}> {
  const tenantId = host.chatContext.peek()?.tenantId ?? null;
  if (!tenantId) {
    return {
      ok: false,
      decision: { ok: false, code: "no_chat_context" },
      tenantId: null,
    };
  }
  // We don't have access to the agent's `ctx.waitUntil` from this
  // debug path; just `void` the close-connection promise — best-effort.
  const decision = await runRateLimitCheck({
    env: host.getEnv(),
    chatId: host.name,
    tenantId,
    userId: host.lastSenderUserId,
    waitUntil: (p) => {
      void p.catch(() => {});
    },
  });
  return { ok: decision.ok, decision, tenantId };
}

export async function debugDump(
  host: DebugRpcHost,
  opts?: { limit?: number }
): Promise<{
  chatId: string;
  persistedMessageCount: number;
  messages: unknown[];
  cachedChatContext: ChatContext | undefined;
  currentTurnUserId: string | null;
  presence: { userId: string; joinedAt: number }[];
}> {
  const limit = Math.min(opts?.limit ?? 50, 200);
  const all = host.getPersistedMessages();
  const tail = all.slice(-limit);
  type PresenceState = { userId: string; joinedAt: number };
  const presence: { userId: string; joinedAt: number }[] = [];
  for (const conn of host.getConnections()) {
    const state = conn.state as PresenceState | null;
    if (state) presence.push({ userId: state.userId, joinedAt: state.joinedAt });
  }
  return {
    chatId: host.name,
    persistedMessageCount: all.length,
    messages: tail,
    cachedChatContext: host.chatContext.peek(),
    currentTurnUserId: host.lastSenderUserId,
    presence,
  };
}

export async function dataDbHealthcheck(host: DebugRpcHost): Promise<{
  ok: boolean;
  profile: { id: string; name: string; database: string; host: string };
  serverTime: string;
  serverVersion: string;
}> {
  const ctx = await getDataDb({
    env: host.getEnv(),
    chatId: host.name,
    cache: host.dataDbCache,
  });
  const rows = (await ctx.sql`SELECT now() AS server_time, version() AS server_version`) as {
    server_time: Date | string;
    server_version: string;
  }[];
  const row = rows[0];
  if (!row) throw new Error("database returned no rows for health check");
  return {
    ok: true,
    profile: {
      id: ctx.profile.id,
      name: ctx.profile.name,
      database: ctx.profile.database,
      host: ctx.profile.host,
    },
    serverTime:
      typeof row.server_time === "string" ? row.server_time : row.server_time.toISOString(),
    serverVersion: row.server_version.split(" on ")[0] ?? row.server_version,
  };
}

export async function dataDbReset(host: DebugRpcHost): Promise<{ ok: true }> {
  await resetDataDb(host.dataDbCache);
  // Bust the chat context cache too, in case the user swapped dbProfile.
  host.chatContext.invalidate();
  return { ok: true };
}

/**
 * Drive the title-summarizer model + sanitize pipeline directly,
 * bypassing the once-per-chat trigger gate and the persist/broadcast
 * steps. We just want to know whether Workers AI returns visible text
 * for a given prompt with our hardened model options.
 *
 * Mirrors production: the title-summarizer routes to a fixed
 * non-thinking model (llama-3.1-8b) because Kimi K2.6's binding
 * ignored enable_thinking:false and burned the entire output budget
 * on reasoning. The probe needs to verify the SAME path production
 * uses, otherwise it'd happily pass while real titles silently fail.
 */
export async function debugTitleProbe(
  host: DebugRpcHost,
  text: string
): Promise<{
  ok: boolean;
  rawTitle: string;
  sanitized: string | null;
  outputChars: number;
  reasoningChars: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number;
  error?: string;
}> {
  const { sanitizeTitle, TITLE_SUMMARY_SYSTEM_PROMPT } = await import("./title-summarizer");
  const startedAt = Date.now();
  try {
    const workersai = createWorkersAI({ binding: host.getEnv().AI });
    const model = workersai("@cf/meta/llama-3.1-8b-instruct");
    const result = await generateText({
      model,
      system: TITLE_SUMMARY_SYSTEM_PROMPT,
      prompt: text,
      temperature: 0.3,
      maxOutputTokens: 64,
    });
    const usage = (result as { usage?: { outputTokens?: number; reasoningTokens?: number } }).usage;
    const reasoningTextLen = (result as { reasoningText?: string }).reasoningText?.length;
    return {
      ok: true,
      rawTitle: result.text,
      sanitized: sanitizeTitle(result.text),
      outputChars: result.text.length,
      reasoningChars: typeof reasoningTextLen === "number" ? reasoningTextLen : null,
      outputTokens: usage?.outputTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      rawTitle: "",
      sanitized: null,
      outputChars: 0,
      reasoningChars: null,
      outputTokens: null,
      reasoningTokens: null,
      durationMs: Date.now() - startedAt,
      error: truncateMessage(err),
    };
  }
}

/**
 * Verify the sandbox really blocks outbound network. Each probe runs
 * a small piece of code via the Dynamic Worker executor and reports
 * whether the expected guard actually fired.
 */
export async function sandboxNetworkProbe(host: DebugRpcHost): Promise<{
  fetchBlocked: boolean;
  connectBlocked: boolean;
  error?: string;
}> {
  const executor = new DynamicWorkerExecutor({
    loader: host.getEnv().LOADER as never,
    timeout: 5_000,
    globalOutbound: null,
  });
  const code = `
    async () => {
      const result = { fetchBlocked: false, connectBlocked: false };
      try {
        const r1 = await fetch("https://example.com");
        result.fetchBlocked = false;
        result.fetchStatus = r1.status;
      } catch (e) {
        result.fetchBlocked = true;
        result.fetchError = String(e && e.message || e).slice(0, 120);
      }
      try {
        const r = new Request("https://example.com");
        const r2 = await fetch(r);
        result.connectBlocked = false;
        result.connectStatus = r2.status;
      } catch (e) {
        result.connectBlocked = true;
        result.connectError = String(e && e.message || e).slice(0, 120);
      }
      return result;
    }
  `;
  const out = await executor.execute(code, []);
  if (out.error) return { fetchBlocked: false, connectBlocked: false, error: out.error };
  const r = out.result as {
    fetchBlocked?: boolean;
    connectBlocked?: boolean;
    fetchError?: string;
    connectError?: string;
    fetchStatus?: number;
    connectStatus?: number;
  };
  return {
    fetchBlocked: !!r.fetchBlocked,
    connectBlocked: !!r.connectBlocked,
    ...(r.fetchError ? { error: r.fetchError } : {}),
  };
}

/**
 * Run the sandbox with a tight 1.5s timeout against an infinite loop,
 * verifying the executor returns an error or empty result within ~2s.
 * Catches a regression where the timeout option is silently ignored.
 *
 * We avoid a tight CPU loop because Workers Loader bills sandbox CPU
 * against the parent isolate. Instead, await a never-resolving
 * promise — the executor's wall-clock timeout should still fire.
 */
export async function sandboxTimeoutProbe(host: DebugRpcHost): Promise<{
  timedOut: boolean;
  durationMs: number;
  errorPreview?: string;
}> {
  const executor = new DynamicWorkerExecutor({
    loader: host.getEnv().LOADER as never,
    timeout: 1_500,
    globalOutbound: null,
  });
  const code = `
    async () => {
      await new Promise(() => {});
      return "should-not-reach";
    }
  `;
  const t0 = Date.now();
  const out = await executor.execute(code, []);
  const durationMs = Date.now() - t0;
  return {
    timedOut: !!out.error || out.result !== "should-not-reach",
    durationMs,
    errorPreview: out.error?.slice(0, 200),
  };
}

/**
 * Drive the chart + artifact tool providers directly to verify wiring
 * without an LLM in the loop. Creates a small bar chart + a markdown
 * artifact, returns the manifest entries.
 */
export async function artifactToolsSmoke(host: DebugRpcHost): Promise<{
  chart: { id: string; url: string; chartType?: string };
  file: { id: string; url: string; name: string };
  list: { count: number; first?: { name: string; kind: string } };
}> {
  const chartProv = chartTools(host);
  const artifactProv = artifactTools(host);
  const chartFns = chartProv.tools as Record<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >;
  const artifactFns = artifactProv.tools as Record<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >;

  const chart = (await chartFns.bar!.execute({
    data: [
      { country: "USA", revenue: 1200 },
      { country: "UK", revenue: 700 },
      { country: "DE", revenue: 540 },
    ],
    x: "country",
    y: "revenue",
    title: "Revenue by country",
  })) as { id: string; url: string; chartType?: string };

  const file = (await artifactFns.save!.execute(
    "summary.md",
    "# Hello\n\nThis is a *test* artifact.",
    "text/markdown"
  )) as { id: string; url: string; name: string };

  const list = (await artifactFns.list!.execute()) as {
    name: string;
    kind: string;
  }[];

  return {
    chart: { id: chart.id, url: chart.url, chartType: chart.chartType },
    file: { id: file.id, url: file.url, name: file.name },
    list: { count: list.length, first: list[0] },
  };
}

/**
 * Directly invoke `db.introspect()` and a tiny `db.query()` to verify
 * the tool wiring without going through the LLM. Returns the *number
 * of schemas + tables seen* and the result of a canonical
 * `SELECT 1+1` to keep the payload small.
 */
export async function dbToolsSmoke(host: DebugRpcHost): Promise<{
  introspect: { schemas: number; tables: number };
  query: { rowCount: number; firstRow: unknown };
}> {
  const provider = dbTools(() =>
    getDataDb({ env: host.getEnv(), chatId: host.name, cache: host.dataDbCache })
  );
  const tools = provider.tools as Record<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >;
  const introspectFn = tools.introspect!.execute as () => Promise<{
    schemas: { tables: unknown[] }[];
  }>;
  const queryFn = tools.query!.execute as (...args: unknown[]) => Promise<{
    rows: unknown[];
    rowCount: number;
  }>;
  const intro = await introspectFn();
  const tables = intro.schemas.reduce((n, s) => n + s.tables.length, 0);
  const q = await queryFn("SELECT 1 + 1 AS two", []);
  return {
    introspect: { schemas: intro.schemas.length, tables },
    query: { rowCount: q.rowCount, firstRow: q.rows[0] },
  };
}

// `runRateLimitCheck` + driver inputs moved to `./rate-limits.ts`
// (subtask c364ae). This module re-imports it for the debug RPC path.

/**
 * Memory smoke test (task a0e754).
 *
 * Drives a tenant+dbProfile pair through the full memory pipeline:
 *   1. persistFact (insert)
 *   2. embedText
 *   3. upsertVector
 *   4. queryVectors (verify the vector indexed and is findable)
 *   5. hydrateFacts (sanity-check Postgres scope)
 *   6. retrieveMemory (full pipeline)
 *   7. softDeleteFact (cleanup)
 *
 * Caller passes tenantId + dbProfileId; both must be real rows in
 * the control-plane (FK-enforced). The script side typically
 * supplies the auto-seeded tenant for the dev user.
 *
 * Returns step-by-step results so the spike script can print a
 * checklist. Throws on any step's hard error — the spike treats a
 * non-zero exit as failure.
 */
export async function memorySmoke(
  host: AgentHost,
  args: { tenantId: string; dbProfileId: string }
): Promise<{
  inserted: { id: string; revived: boolean };
  embed: { dims: number };
  vector: { hits: number; topId: string | null; topScore: number | null };
  hydrated: { count: number };
  recall: { facts: number; topScore: number | null };
  cleanup: { deletedId: string };
}> {
  const env = host.getEnv();
  const content = `smoke fact ${Date.now()} — orders.total_cents is in cents not dollars`;

  // 1. persist
  const pres = await persistFact(env, {
    tenantId: args.tenantId,
    dbProfileId: args.dbProfileId,
    kind: "schema_semantic",
    content,
    sourceChatId: host.name,
    sourceTurnId: null,
    createdBy: null,
  });
  if (!pres.ok) throw new Error(`persistFact failed: ${pres.reason}`);
  const id = pres.row.id;

  // 2. embed
  const vec = await embedText(env, content);

  // 3. upsert
  await upsertVector(env, {
    id,
    values: vec,
    tenantId: args.tenantId,
    metadata: {
      dbProfileId: args.dbProfileId,
      kind: "schema_semantic",
      createdAt: pres.row.createdAt.toISOString(),
    },
  });

  // 4. query — give the index a moment to settle (V2 mutations are
  // async). 1.5s is conservative; in practice it's often <500ms.
  await new Promise((r) => setTimeout(r, 1500));
  const hits = await queryVectors(env, {
    vector: vec,
    tenantId: args.tenantId,
    dbProfileId: args.dbProfileId,
    topK: 3,
  });

  // 5. hydrate
  const rows = await hydrateFacts(env, {
    tenantId: args.tenantId,
    dbProfileId: args.dbProfileId,
    ids: hits.map((h) => h.id),
  });

  // 6. retrieve
  const recall = await retrieveMemory({
    env,
    tenantId: args.tenantId,
    dbProfileId: args.dbProfileId,
    query: "what unit are order totals in?",
  });

  // 7. soft-delete to leave the index clean
  const deleted = await softDeleteFact(env, {
    tenantId: args.tenantId,
    dbProfileId: args.dbProfileId,
    idOrHash: { kind: "id", value: id },
  });

  return {
    inserted: { id, revived: pres.revivedFromSoftDelete },
    embed: { dims: vec.length },
    vector: {
      hits: hits.length,
      topId: hits[0]?.id ?? null,
      topScore: hits[0]?.score ?? null,
    },
    hydrated: { count: rows.length },
    recall: { facts: recall.facts.length, topScore: recall.scores[0] ?? null },
    cleanup: { deletedId: deleted?.id ?? "<not_deleted>" },
  };
}

/**
 * Delete a list of fact ids from Vectorize. Used by
 * `debug-memory-clear.ts` after the Postgres rows are gone so the
 * vector index doesn't accumulate orphans.
 *
 * Returns the count attempted — V2's `deleteByIds` is async and
 * we don't wait on the mutation id; the operator runs
 * `inspect-memory.ts` afterwards to verify.
 */
export async function debugMemoryDeleteVectors(
  host: AgentHost,
  args: { ids: string[]; tenantId: string }
): Promise<{ attempted: number }> {
  const env = host.getEnv();
  if (args.ids.length === 0) return { attempted: 0 };
  // Chunk in 1000s — the binding accepts large arrays but smaller
  // batches give better progress visibility on big sweeps.
  const CHUNK = 1000;
  for (let i = 0; i < args.ids.length; i += CHUNK) {
    const slice = args.ids.slice(i, i + CHUNK);
    try {
      await env.VECTORIZE_MEMORY.deleteByIds(slice);
    } catch (err) {
      // Don't throw — log and continue. Worst case we leak a few
      // orphan vectors that the periodic sweep will reap.
      console.warn("vectorize deleteByIds failed:", truncateMessage(err));
    }
  }
  return { attempted: args.ids.length };
}
