import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "./env";

/**
 * Default model — Kimi K2.6 on Workers AI. 1T params, 262k context,
 * function calling + reasoning. Pricing: $0.95/M in, $4/M out.
 */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.6";

/**
 * One ChatAgent instance per chat (DO id = chatId). Hosts:
 *   - message persistence + agentic loop (via Think)
 *   - virtual filesystem workspace (DO SQLite + R2 spillover, via @cloudflare/shell)
 *   - LLM via Workers AI (no third-party keys)
 *
 * Tools (db.*, chart.*, artifact.*) and Code Mode wiring land in later subtasks.
 * For now this is the minimal Think subclass + a healthcheck RPC method.
 */
export class ChatAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.ARTIFACTS,
    name: () => this.name,
  });

  override getModel(): LanguageModel {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai(DEFAULT_MODEL);
  }

  /** Simple RPC method, callable from api-gateway via service binding for smoke tests. */
  async healthcheck() {
    return {
      ok: true,
      agent: "ChatAgent",
      chatId: this.name,
      time: new Date().toISOString(),
    };
  }
}
