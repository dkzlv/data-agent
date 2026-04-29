import { callable } from "agents";
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
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
}
