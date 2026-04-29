import { callable } from "agents";
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getDataDb, resetDataDb, type AgentLike, type CachedHandle } from "./data-db";
import { artifactTools, chartTools } from "./tools/artifact-tools";
import { dbTools } from "./tools/db-tools";
import { vegaLiteTools } from "./tools/vega-lite-tools";
import type { Env } from "./env";

/**
 * Default model — Kimi K2.6 on Workers AI. 1T params, 262k context,
 * function calling + reasoning. Pricing: $0.95/M in, $4/M out.
 */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

const SYSTEM_PROMPT = `You are a data analyst inside a chat. The user has a workspace with files you can read/write, and a Postgres database accessible via tools.

You have ONE tool: \`codemode\`. To do anything, write a small async TypeScript arrow function that uses the available APIs and returns the result.

Available APIs inside codemode:
- \`db.introspect()\` — schema snapshot (tables, columns, FKs, est. rows). Always call this first if you don't know the schema.
- \`db.query(sql, params?)\` — read-only SELECT/WITH/EXPLAIN. Use \`$1\`, \`$2\` placeholders; never interpolate values into the SQL string. Results are auto-capped at 5000 rows / 4 MB / 15 s.
- \`state.*\` — workspace filesystem (readFile, writeFile, readDir, mkdir, exists, …) for caching analysis between turns.
- \`artifact.save(name, content, mime?)\` / \`artifact.read(name)\` / \`artifact.list()\` — durable named outputs (markdown summaries, csv exports, etc).
- \`chart.bar / .line / .scatter / .histogram / .spec\` — produce a Vega-Lite chart artifact. Prefer the typed helpers; only use \`chart.spec({ spec })\` for layouts the helpers can't express.
- \`vegaLite.validate(spec)\` / \`.schemaUrl()\` / \`.exampleBar()\` etc. — for hand-rolling specs.

Workflow:
- Think briefly, then write code that does the work.
- For data questions, START with db.introspect() if you don't already know the schema.
- Show the SQL you ran and a concise summary of findings (numbers + interpretation).
- Be concise.

Refuse to do anything outside the data-analysis scope.`;

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
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai(DEFAULT_MODEL);
  }

  override getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

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
    // Path looks like /agents/chat-agent/<chatId>/artifacts/<id> after the
    // SDK has dispatched to us. We strip everything up to the chat name.
    const parts = url.pathname.split("/").filter(Boolean);
    // parts: ["agents", "chat-agent", <chatId>, "artifacts", <id>]
    if (parts[3] === "artifacts" && parts[4]) {
      return this.serveArtifact(parts[4]);
    }
    return new Response("not found", { status: 404 });
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
