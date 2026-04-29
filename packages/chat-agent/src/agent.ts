import { callable } from "agents";
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getDataDb, resetDataDb, type AgentLike, type CachedHandle } from "./data-db";
import type { Env } from "./env";

/**
 * Default model — Kimi K2.6 on Workers AI. 1T params, 262k context,
 * function calling + reasoning. Pricing: $0.95/M in, $4/M out.
 */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

const SYSTEM_PROMPT = `You are a data analyst inside a chat. The user has a workspace with files you can read/write, and (in later turns) a Postgres database connected via tools.

You have ONE tool: \`codemode\`. To do anything, write a small async TypeScript arrow function that uses the available APIs and returns the result.

Available APIs inside codemode:
- \`state.*\` — workspace filesystem (readFile, writeFile, readDir, mkdir, exists, …)

Workflow:
- Think briefly, then write code that does the work.
- Always show your reasoning + the code in the final answer.
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
    const codemode = createCodeTool({
      tools: [stateTools(this.workspace)],
      executor,
    });
    return { codemode };
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
}
