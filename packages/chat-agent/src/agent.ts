import { callable, type Connection, type ConnectionContext } from "agents";
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getDataDb, resetDataDb, type AgentLike, type CachedHandle } from "./data-db";
import { buildSystemPrompt, type ChatContext } from "./system-prompt";
import { artifactTools, chartTools } from "./tools/artifact-tools";
import { dbTools } from "./tools/db-tools";
import { vegaLiteTools } from "./tools/vega-lite-tools";
import { readSecret, type Env } from "./env";

/**
 * Default model — Kimi K2.6 on Workers AI. 1T params, 262k context,
 * function calling + reasoning. Pricing: $0.95/M in, $4/M out.
 *
 * Set `CHAT_MODEL` in vars to override (e.g. for A/B). Recognized values:
 *  - `@cf/moonshotai/kimi-k2.6` (default)
 *  - `@cf/zai-org/glm-4.7-flash` (faster, cheaper, smaller context)
 *  - `@cf/openai/gpt-oss-120b`  (reasoning-capable, ~120B)
 *
 * `reasoning_effort` is forwarded to the Workers AI binding as a
 * passthrough; it has no effect on models that don't support reasoning.
 */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";
const DEFAULT_REASONING_EFFORT: "low" | "medium" | "high" = "medium";

/**
 * ChatAgent — extends `Think`, the AI-chat-aware Agent base.
 *
 * Persistence (subtask 382d1f):
 *   `Think` persists every turn (user messages, assistant text, tool calls,
 *   tool results) into this DO's SQLite via the `cf_agent_chat_messages`
 *   protocol. On every WS connect the server replays the full history to
 *   the client. This is verified end-to-end by `scripts/spike.ts`.
 *
 * Resumable streaming (subtask 382d1f):
 *   When a client disconnects mid-turn, the model continues to run; the
 *   client reconnects and sends `cf_agent_stream_resume_request`, the
 *   server replies with `cf_agent_stream_resuming` and replays buffered
 *   chunks, ending with `done`. If there's nothing in flight the server
 *   replies with `cf_agent_stream_resume_none`. We get this for free —
 *   `Think` ships `ContinuationState` + an in-memory chunk buffer per
 *   active request, keyed by `requestId`.
 *
 * We don't need to override anything to get either; we only rely on
 * `Think` not being misconfigured. Persistence is anchored to `this.name`
 * (the chat id), so cross-chat isolation comes from the DO name routing.
 */
export class ChatAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.ARTIFACTS,
    name: () => this.name,
  });

  /**
   * Lazy data-plane Postgres connection — populated by `getDataDb()` on
   * first use, persists for the lifetime of the DO instance. See `data-db.ts`.
   * Marked public so `data-db.ts` can read/write it through the agent
   * reference without leaking through external types.
   */
  _dataDb?: CachedHandle;

  /** Helper exposed to satisfy `AgentLike` without leaking `this.env` (protected). */
  getEnv(): Env {
    return this.env;
  }

  /** Adapter object for the data-db helpers. Holds a stable reference to
   *  this instance's `_dataDb` slot via getter/setter aliases. */
  private get _dataDbHost(): AgentLike {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      name: this.name,
      getEnv: () => self.env,
      get _dataDb() {
        return self._dataDb;
      },
      set _dataDb(v) {
        self._dataDb = v;
      },
    };
  }

  override getModel(): LanguageModel {
    const modelId = (this.env.CHAT_MODEL ?? DEFAULT_MODEL) as
      | "@cf/moonshotai/kimi-k2.6"
      | "@cf/zai-org/glm-4.7-flash"
      | "@cf/openai/gpt-oss-120b";
    const workersai = createWorkersAI({ binding: this.env.AI });
    // sessionAffinity uses the DO id (globally unique, stable for the
    // lifetime of this chat) so all turns from this chat hit the same
    // replica — improves Workers AI KV-prefix-cache hit rate.
    return workersai(modelId, {
      sessionAffinity: this.sessionAffinity,
      reasoning_effort: DEFAULT_REASONING_EFFORT,
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false,
      },
    });
  }

  override getSystemPrompt(): string {
    // Synchronous fallback used by Think when beforeTurn doesn't override.
    return buildSystemPrompt(this._cachedChatContext);
  }

  /**
   * Per-turn hook: lazy-resolve chat context (title + database) from the
   * control-plane on the first turn, cache for subsequent ones, and
   * inject it into the system prompt. Falls back gracefully if the
   * control-plane is unreachable — we never block a turn on prompt
   * decoration.
   */
  override async beforeTurn(): Promise<void | { system: string }> {
    if (!this._cachedChatContext) {
      try {
        this._cachedChatContext = await this.resolveChatContext();
      } catch (err) {
        console.warn("beforeTurn: chat context resolve failed", {
          chatId: this.name,
          err: (err as Error).message,
        });
      }
    }
    return { system: buildSystemPrompt(this._cachedChatContext) };
  }

  /**
   * Read chat title + (optional) attached dbProfile metadata from the
   * control-plane. We do NOT include user identity here — multi-user
   * chats have several users, and the prompt is shared. The user's name
   * lands as a per-turn message metadata block in the future.
   */
  private async resolveChatContext(): Promise<ChatContext> {
    const { createDbClient, schema } = await import("@data-agent/db");
    const { eq } = await import("drizzle-orm");
    const url = await readSecret(this.env.CONTROL_PLANE_DB_URL);
    const { db, client } = createDbClient({ url, max: 2 });
    try {
      const [chat] = await db
        .select({
          title: schema.chat.title,
          dbProfileId: schema.chat.dbProfileId,
        })
        .from(schema.chat)
        .where(eq(schema.chat.id, this.name))
        .limit(1);

      const ctx: ChatContext = { chatTitle: chat?.title };
      if (chat?.dbProfileId) {
        const [profile] = await db
          .select({
            name: schema.dbProfile.name,
            host: schema.dbProfile.host,
            database: schema.dbProfile.database,
          })
          .from(schema.dbProfile)
          .where(eq(schema.dbProfile.id, chat.dbProfileId))
          .limit(1);
        if (profile) ctx.database = profile;
      }
      return ctx;
    } finally {
      void client.end({ timeout: 1 }).catch(() => {});
    }
  }

  /**
   * Cache for per-chat context (chat title, dbProfile name) so we don't
   * round-trip to the control-plane on every turn. Refresh via
   * `setChatContext()` (called by the api-gateway when the chat is
   * opened or its dbProfile changes).
   */
  private _cachedChatContext?: ChatContext;

  override getTools(): ToolSet {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER as never,
      timeout: 30_000,
      globalOutbound: null,
    });
    const host = this._dataDbHost;
    const codemode = createCodeTool({
      tools: [
        stateTools(this.workspace),
        dbTools(() => getDataDb(host)),
        artifactTools(this),
        chartTools(this),
        vegaLiteTools(),
      ],
      executor,
    });
    return { codemode };
  }

  /**
   * Multi-user presence: broadcast the set of connected users whenever
   * someone joins or leaves. The custom message type
   * `data_agent_presence` is consumed by the chat UI and rendered as a
   * compact "who's here" header.
   *
   * Connection state is keyed by Connection.id (transient, per-WS).
   * userId/tenantId are pulled from the headers stamped onto the
   * upgrade request by `onBeforeConnect` in `index.ts`.
   */
  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // Defer to Think's own onConnect first (it sends the message replay
    // and other init traffic).
    await super.onConnect(connection, ctx);

    const userId = ctx.request.headers.get("x-data-agent-user-id") ?? "anonymous";
    const tenantId = ctx.request.headers.get("x-data-agent-tenant-id") ?? "";
    connection.setState({ userId, tenantId, joinedAt: Date.now() } as never);
    this.broadcastPresence();
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    await super.onClose(connection, code, reason, wasClean);
    // Connection is already removed from `getConnections()` by the time
    // onClose runs, so the broadcast naturally reflects the new state.
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    type PresenceState = { userId: string; tenantId?: string; joinedAt: number };
    const seen = new Map<string, { userId: string; joinedAt: number }>();
    for (const conn of this.getConnections<PresenceState>()) {
      const state = conn.state;
      if (!state) continue;
      const existing = seen.get(state.userId);
      if (!existing || existing.joinedAt > state.joinedAt) {
        seen.set(state.userId, { userId: state.userId, joinedAt: state.joinedAt });
      }
    }
    const message = JSON.stringify({
      type: "data_agent_presence",
      users: Array.from(seen.values()).sort((a, b) => a.joinedAt - b.joinedAt),
    });
    this.broadcast(message);
  }

  /**
   * HTTP handler for non-WS requests routed by the agents SDK.
   * Currently serves artifact bytes:
   *   GET /artifacts/<id>      → 200 with Content-Type from manifest
   *
   * Authentication is enforced by the api-gateway (which is the only path
   * to this DO in production) and additionally by the WS-token scheme on
   * the worker, but we re-validate the token here as defense in depth.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Path looks like /agents/chat-agent/<chatId>/... after the SDK has
    // dispatched to us. parts = ["agents", "chat-agent", <chatId>, ...].
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[3] === "artifacts") {
      if (parts[4]) return this.serveArtifact(parts[4]);
      return this.serveArtifactList();
    }
    return new Response("not found", { status: 404 });
  }

  private async serveArtifactList(): Promise<Response> {
    try {
      const manifestText = await this.workspace.readFile("/artifacts/_manifest.json");
      if (!manifestText) {
        return Response.json({ artifacts: [] });
      }
      const manifest = JSON.parse(manifestText) as {
        artifacts?: {
          id: string;
          name: string;
          kind?: string;
          mime?: string;
          size?: number;
          createdAt?: string;
          chartType?: string;
          url?: string;
        }[];
      };
      return Response.json({ artifacts: manifest.artifacts ?? [] });
    } catch (err) {
      console.warn("serveArtifactList failed", { chatId: this.name, err: (err as Error).message });
      return Response.json({ artifacts: [] });
    }
  }

  private async serveArtifact(artifactId: string): Promise<Response> {
    try {
      const manifestText = await this.workspace.readFile("/artifacts/_manifest.json");
      if (!manifestText) return new Response("not found", { status: 404 });
      const manifest = JSON.parse(manifestText) as {
        artifacts?: { id: string; mime?: string; name?: string }[];
      };
      const ref = manifest.artifacts?.find((a) => a.id === artifactId);
      if (!ref) return new Response("not found", { status: 404 });
      const body = await this.workspace.readFile(`/artifacts/${ref.id}`);
      if (body == null) return new Response("not found", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": ref.mime ?? "application/octet-stream",
          "cache-control": "private, max-age=86400, immutable",
          "x-artifact-id": ref.id,
          ...(ref.name ? { "x-artifact-name": ref.name } : {}),
        },
      });
    } catch (err) {
      console.warn("serveArtifact failed", { artifactId, err: (err as Error).message });
      return new Response("not found", { status: 404 });
    }
  }

  /** Simple RPC method for service-binding smoke tests. */
  @callable()
  async healthcheck() {
    return {
      ok: true,
      agent: "ChatAgent",
      chatId: this.name,
      time: new Date().toISOString(),
    };
  }

  /**
   * RPC for spike + admin tooling: lazily connect to the user's database
   * and return a tiny health probe. Errors propagate as exceptions.
   */
  @callable()
  async dataDbHealthcheck(): Promise<{
    ok: boolean;
    profile: { id: string; name: string; database: string; host: string };
    serverTime: string;
    serverVersion: string;
  }> {
    const ctx = await getDataDb(this._dataDbHost);
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

  /** Force the data-db client to be re-resolved on the next call. */
  @callable()
  async dataDbReset(): Promise<{ ok: true }> {
    await resetDataDb(this._dataDbHost);
    // Bust the chat context cache too, in case the user swapped dbProfile.
    this._cachedChatContext = undefined;
    return { ok: true };
  }

  /**
   * Set the chat context (title, attached database, current user) so the
   * system prompt can render an accurate per-chat header. Called by the
   * api-gateway right after a turn is initiated, before the model runs.
   *
   * Keeping this as an explicit RPC (rather than re-querying control-plane
   * on every turn from inside the DO) avoids a Postgres round-trip per
   * turn — the gateway already has this info from session validation.
   */
  @callable()
  async setChatContext(ctx: ChatContext): Promise<{ ok: true }> {
    this._cachedChatContext = ctx;
    return { ok: true };
  }

  /**
   * RPC for spike harnesses: drive the chart + artifact toolproviders
   * directly to verify wiring without an LLM in the loop. Creates a small
   * bar chart + a markdown artifact, returns the manifest entries.
   */
  @callable()
  async artifactToolsSmoke(): Promise<{
    chart: { id: string; url: string; chartType?: string };
    file: { id: string; url: string; name: string };
    list: { count: number; first?: { name: string; kind: string } };
  }> {
    const chartProv = chartTools(this);
    const artifactProv = artifactTools(this);
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
   * RPC for spike harnesses: directly invoke `db.introspect()` and a tiny
   * `db.query()` to verify the tool wiring without going through the LLM.
   * Returns the *number of schemas + tables seen* and the result of a
   * canonical `SELECT 1+1` to keep the payload small.
   */
  @callable()
  async dbToolsSmoke(): Promise<{
    introspect: { schemas: number; tables: number };
    query: { rowCount: number; firstRow: unknown };
  }> {
    const provider = dbTools(() => getDataDb(this._dataDbHost));
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
}
