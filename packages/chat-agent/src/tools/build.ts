/**
 * Tool-set assembly for the ChatAgent.
 *
 * Earlier `agent.getTools()` inline-constructed `DynamicWorkerExecutor`,
 * `createCodeTool`, `wrapCodemodeTool`, and the 5 capability providers,
 * plus the event router that mapped wrap events to `chat.codemode_*`
 * log calls. ~50 LOC of wiring inside the class, mixing executor
 * config, capability list, and observability.
 *
 * Pulling this out gives:
 *   - One place to tweak executor opts (`SANDBOX_TIMEOUT_MS`,
 *     `SANDBOX_GLOBAL_OUTBOUND`).
 *   - Adding a tool = one line in `CAPABILITIES`.
 *   - The agent's `getTools()` shrinks to a single delegation.
 *   - The wrapper's onEvent stays decoupled from the agent class
 *     (caller injects).
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import type { ToolSet } from "ai";
import { getDataDb, type DataDbHandle } from "../data-db";
import type { Env } from "../env";
import { artifactTools, chartTools } from "./artifact-tools";
import { wrapCodemodeTool, type CodemodeWrapEvent } from "./codemode-wrap";
import { dbTools } from "./db-tools";
import { vegaLiteTools } from "./vega-lite-tools";

/** Sandbox wall-clock cap. Matches `STATEMENT_TIMEOUT_MS` (25s) +
 *  ~5s headroom for serialization, pool connect, byte-cap enforcement.
 *  Past this the Worker Loader kills the isolate. */
export const SANDBOX_TIMEOUT_MS = 30_000;

/**
 * Sandbox outbound network policy. `null` blocks every outbound socket;
 * the user's data DB calls go through the host worker via the codemode
 * capability binding, NOT through the sandbox's network stack. See
 * `SECURITY.md` defense tier 4.
 */
export const SANDBOX_GLOBAL_OUTBOUND: null = null;

/**
 * Minimum agent surface needed to build the tool set. Keeping this
 * narrow makes the function testable with a fake agent.
 */
export interface ToolBuildHost {
  /** chatId — used in artifact URLs + db cache key. */
  name: string;
  workspace: Workspace;
  dataDbCache: DataDbHandle;
}

export interface BuildAgentToolsInputs {
  env: Env;
  host: ToolBuildHost;
  /** Caller-injected so logging stays in the agent's TurnLogger
   *  envelope (chatId/tenantId/userId/turnId all auto-bound). */
  onCodemodeEvent?: (ev: CodemodeWrapEvent) => void;
  /** Optional prefix prepended to the wrapped codemode tool's
   *  description. Belt-and-braces against the "model writes code as
   *  text" failure mode (chat feca41d8): the system prompt
   *  disambiguates tool-call vs assistant text, but models read tool
   *  docs as a separate channel — putting the same directive in the
   *  description reinforces it. */
  descriptionPrepend?: string;
}

/**
 * Build the codemode tool set. Returns `{ codemode }` — the AI SDK
 * sees a single meta-tool; capabilities live inside the sandbox.
 */
export function buildAgentTools(inputs: BuildAgentToolsInputs): ToolSet {
  const { env, host, onCodemodeEvent, descriptionPrepend } = inputs;

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER as never,
    timeout: SANDBOX_TIMEOUT_MS,
    globalOutbound: SANDBOX_GLOBAL_OUTBOUND,
  });

  const dataDbInputs = { env, chatId: host.name, cache: host.dataDbCache };
  const capabilities = [
    stateTools(host.workspace),
    dbTools(() => getDataDb(dataDbInputs)),
    artifactTools(host),
    chartTools(host),
    vegaLiteTools(),
  ];

  const rawCodemode = createCodeTool({ tools: capabilities, executor });

  // Resilience wrapper:
  //   - Sandbox throws (unknown capability, runtime error, fetch
  //     blocked, etc.) become structured `{ error, recoverable }`
  //     results so the model can adapt instead of aborting the
  //     whole turn (chat 236a4117 was a real instance).
  //   - Tool results larger than DEFAULT_RESULT_CHAR_CAP (5,000 JSON
  //     chars) are replaced with a truncation marker so an
  //     unexpectedly-large `db.query` response doesn't poison the
  //     next turn's input budget or balloon the persisted message
  //     row.
  const codemode = wrapCodemodeTool(rawCodemode, {
    onEvent: onCodemodeEvent,
    ...(descriptionPrepend ? { descriptionPrepend } : {}),
  });

  return { codemode };
}
