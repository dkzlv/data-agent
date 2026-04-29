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
 *   - Adding a tool = one line in `capabilities`.
 *   - The agent's `getTools()` shrinks to a single delegation.
 *   - The wrapper's onEvent stays decoupled from the agent class
 *     (caller injects).
 *
 * Capability surface (post task 722e12 — kept minimal so the model
 * spends the prompt budget on data work, not tool docs):
 *
 *   - `db.*`        introspect + read-only SQL
 *   - `artifact.*`  save/read/list named outputs (markdown, csv, …)
 *   - `chart.save`  persist a Vega-Lite v5 spec (single signature)
 *   - `memory.*`    cross-chat fact memory (only when `memoryHost`
 *                   is supplied — task a0e754; gated so the typed
 *                   declarations don't land in the prompt for chats
 *                   without a resolved tenant + dbProfile).
 *
 * `state.*` (~5.8k chars of FS docs in the codemode description) was
 * dropped: cross-turn state was never used by the model, the
 * `Workspace` instance is still wired through `host` for artifact
 * R2 persistence. `vegaLite.*` (~1.1k chars) was dropped: 0
 * invocations across 25 production turns and `chart.save` already
 * validates the spec on the way to R2.
 */
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { Workspace } from "@cloudflare/shell";
import type { ToolSet } from "ai";
import { getDataDb, type DataDbHandle } from "../data-db";
import type { Env } from "../env";
import { memoryTools, type MemoryToolHost } from "../memory/tools";
import { artifactTools, chartTools } from "./artifact-tools";
import { wrapCodemodeTool, type CodemodeWrapEvent } from "./codemode-wrap";
import { dbTools } from "./db-tools";

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
  /**
   * Memory-tool integration host (task a0e754). Optional — when null
   * the `memory.*` provider is omitted entirely (no typed
   * declarations land in the prompt either, so the model never sees
   * a memory surface that wouldn't work). The agent passes null
   * when memory is feature-flagged off.
   */
  memoryHost?: MemoryToolHost | null;
  /** Caller-injected so logging stays in the agent's TurnLogger
   *  envelope (chatId/tenantId/userId/turnId all auto-bound). */
  onCodemodeEvent?: (ev: CodemodeWrapEvent) => void;
}

/**
 * Build the codemode tool set. Returns `{ codemode }` — the AI SDK
 * sees a single meta-tool; capabilities live inside the sandbox.
 *
 * The single tool carries an Anthropic `cache_control: ephemeral`
 * provider option. Anthropic's prompt-cache hierarchy is
 * `tools → system → messages` (cumulative): a breakpoint on the
 * (only) tool definition caches **tools + system** as one prefix, so
 * every turn after the first reads the static prefix instead of
 * paying the full input-token bill. Required for any meaningful win
 * against the codemode tool description (still ~5k chars even after
 * the 722e12 trim). See AGENTS.md decision #16 for context.
 */
export function buildAgentTools(inputs: BuildAgentToolsInputs): ToolSet {
  const { env, host, onCodemodeEvent, memoryHost } = inputs;

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER as never,
    timeout: SANDBOX_TIMEOUT_MS,
    globalOutbound: SANDBOX_GLOBAL_OUTBOUND,
  });

  const dataDbInputs = { env, chatId: host.name, cache: host.dataDbCache };
  // Memory provider is null when memory is disabled (no dbProfile,
  // missing tenant context, or feature flag off). Skipped here means
  // the typed declarations also don't land in the prompt — so the
  // model never sees a `memory.*` namespace it can't actually use.
  const memoryProvider = memoryHost ? memoryTools(env, memoryHost) : null;
  const capabilities = [
    dbTools(() => getDataDb(dataDbInputs)),
    artifactTools(host),
    chartTools(host),
    ...(memoryProvider ? [memoryProvider] : []),
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
  });

  // Attach Anthropic prompt-cache breakpoint to the (only) tool
  // entry. AI SDK forwards `Tool.providerOptions.anthropic` to
  // Anthropic's tool definition `cache_control` field; the native
  // `/anthropic` gateway endpoint preserves it. With a single tool
  // the breakpoint sits on the last tool by definition.
  //
  // NOTE: production currently routes through the gateway's
  // `/compat/chat/completions` (OpenAI-shaped) endpoint, which
  // STRIPS `cache_control`. This option is therefore a no-op today
  // — kept in place so when we re-enable the native Anthropic
  // endpoint (after fixing the CF_AIG_TOKEN auth scoping that
  // broke prod on PR #12), caching turns on automatically.
  //
  // Workers AI / openai-compat paths ignore unknown providerOptions
  // keys, so this is safe to set unconditionally.
  const upstreamProviderOptions = (codemode as { providerOptions?: Record<string, unknown> })
    .providerOptions;
  const codemodeCached = {
    ...codemode,
    providerOptions: {
      ...upstreamProviderOptions,
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };

  return { codemode: codemodeCached as typeof codemode };
}
