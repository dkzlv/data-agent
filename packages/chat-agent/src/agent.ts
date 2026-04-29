import { callable, type Connection, type ConnectionContext } from "agents";
import { Think, type ChatResponseResult, type ToolCallResultContext } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import type { LanguageModel, ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { hashSql, logEvent, safePayload, truncateMessage } from "@data-agent/shared";
import { auditFromAgent } from "./audit";
import { checkRateLimits, RateLimitError } from "./rate-limits";
import { getDataDb, resetDataDb, type AgentLike, type CachedHandle } from "./data-db";
import { buildSystemPrompt, type ChatContext } from "./system-prompt";
import { artifactTools, chartTools } from "./tools/artifact-tools";
import { dbTools } from "./tools/db-tools";
import { vegaLiteTools } from "./tools/vega-lite-tools";
import { extractFirstUserText, summarizeAndPersistTitle } from "./title-summarizer";
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
/**
 * Count active WS connections to the agent. Used in observability
 * spans so we can correlate "WS dropped" events with "turn aborted"
 * (subtask 9fa055 streaming-debug).
 *
 * Uses a duck-typed cast because `agents`'s base class exposes
 * `getConnections()` typed for state-narrowing — we just need a count.
 */
function countConnections(agent: { getConnections: () => Iterable<unknown> }): number {
  let n = 0;
  // biome-ignore lint/correctness/noUnusedVariables: counting only
  for (const _ of agent.getConnections()) n++;
  return n;
}

/**
 * Pull the diagnostics-relevant fields out of an arbitrary thrown
 * value. We *always* want:
 *
 *   - error class name (`AbortError`, `TypeError`, ...)
 *   - the message (truncated)
 *   - one level of `cause` (the AI SDK and `fetch` both wrap
 *     transport failures; the cause is where the actual reason
 *     lives — "TLS handshake failed", "Aborted by signal", etc.)
 *   - whether this is "an abort" — true for `AbortError`, true if
 *     the message contains "aborted" (covers DOM `AbortSignal`,
 *     stream-controller aborts, agents-SDK cancel propagation).
 *
 * Returns a small object so downstream loggers / audit writers
 * don't each re-implement the destructuring.
 */
function describeError(err: unknown): {
  name: string;
  message: string;
  cause: string | null;
  isAbort: boolean;
} {
  if (err instanceof Error) {
    const causeRaw = (err as Error & { cause?: unknown }).cause;
    const cause = causeRaw
      ? causeRaw instanceof Error
        ? `${causeRaw.name}: ${causeRaw.message}`
        : String(causeRaw)
      : null;
    const msg = err.message ?? "";
    const isAbort =
      err.name === "AbortError" ||
      msg === "BodyStreamBuffer was aborted" ||
      msg.toLowerCase().includes("aborted");
    return {
      name: err.name || "Error",
      message: msg.slice(0, 500),
      cause: cause ? cause.slice(0, 500) : null,
      isAbort,
    };
  }
  const s = String(err);
  return {
    name: "non-error",
    message: s.slice(0, 500),
    cause: null,
    isAbort: s.toLowerCase().includes("aborted"),
  };
}

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
    // Stamp for the audit row built later (see onChatResponse).
    this._modelId = modelId;

    const workersai = createWorkersAI({ binding: this.env.AI });

    // CF AI Gateway (5bcb5f) — when `AI_GATEWAY_ID` is set, every
    // inference call is proxied through the named gateway. The
    // gateway dashboard provides cost tracking, request logs,
    // caching, and replay; in return we attach metadata so the
    // dashboard can slice usage per tenant/chat/user. Skipped in
    // local dev where the binding may not have gateway access yet.
    const gatewayId = this.env.AI_GATEWAY_ID;
    const ctx = this._cachedChatContext;
    const gateway = gatewayId
      ? {
          id: gatewayId,
          metadata: {
            tenantId: ctx?.tenantId ?? "unknown",
            chatId: this.name,
            userId: this._currentTurnUserId ?? "unknown",
            model: modelId,
          },
          // No client-side cache. SQL-introspection prompts include
          // tenant-specific schema hashes which already de-dupe
          // identical workloads at the *prompt* level; CF's content
          // hash takes care of the rest. We could opt-in
          // `cacheTtl: 600` later if cost dictates, but caching
          // analytical answers is risky (data drifts).
        }
      : undefined;

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
      ...(gateway ? { gateway } : {}),
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
        logEvent({
          event: "chat.context_resolve_failed",
          level: "warn",
          chatId: this.name,
          error: truncateMessage(err),
        });
      }
    }

    const tenantId = this._cachedChatContext?.tenantId;

    // Rate-limit gate (947c38) — runs *before* the audit insert so
    // the count reflects strictly previous turns. We only check when
    // we know the tenantId; un-resolvable chats have a different
    // failure mode (the LLM call itself will fail).
    if (tenantId) {
      const decision = await this.checkRateLimits(tenantId);
      if (!decision.ok) {
        // Throwing inside `beforeTurn` propagates to Think's error
        // pipeline which calls our `onChatError` and surfaces a
        // turn.error audit row. We deliberately use a custom error
        // class so the UX layer (subtask 2f89ff) can render a
        // dedicated "you've hit your daily/hourly limit" message
        // instead of the generic agent-error string.
        throw new RateLimitError(decision.code, decision.max, decision.windowMs, decision.current);
      }
    }

    // Mark the turn start for observability span timing (9fa055)
    // and assign a fresh `turnId` so every event for this turn —
    // start, each step, every Nth chunk, tool-call, complete/error,
    // and any onClose during the turn — can be joined in Workers
    // Logs by a single field.
    this._turnStartedAt = Date.now();
    this._turnId = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    this._lastChunkAt = Date.now();
    this._lastChunkType = null;
    this._chunkCount = 0;
    this._stepCount = 0;
    this._toolCalls = [];

    // Audit (1dd311) — record turn.start. Best-effort, never blocks.
    if (tenantId) {
      this.ctx.waitUntil(
        auditFromAgent(this.env, {
          tenantId,
          chatId: this.name,
          userId: this._currentTurnUserId ?? null,
          action: "turn.start",
          target: this.name,
          payload: {
            dbProfileId: this._cachedChatContext?.dbProfileId ?? null,
            turnId: this._turnId,
          },
        })
      );
    }

    // Observability: turn-start span.
    logEvent({
      event: "chat.turn_start",
      chatId: this.name,
      tenantId: tenantId ?? null,
      userId: this._currentTurnUserId ?? null,
      dbProfileId: this._cachedChatContext?.dbProfileId ?? null,
      model: this._modelId,
      turnId: this._turnId,
      // How many WS connections are currently attached, so we can
      // correlate `onClose` (drops) with in-flight turns later.
      connections: countConnections(this),
    });

    // Title auto-summarizer (subtask 16656a). Detect "this is the first
    // user message in the chat" and kick off a fire-and-forget rename
    // via Workers AI. Defensive guards:
    //
    //   - `_titleSummaryScheduled` per-DO flag stops re-fires on
    //     resume/reconnect within the same DO instance.
    //   - We count user-role messages in the persisted history. Think
    //     persists the just-arrived user message before `beforeTurn`
    //     runs, so on the first turn we expect exactly 1.
    //   - If the DO hibernates and a *new* user message arrives later,
    //     `userMsgs.length` will be >1 and we naturally skip — no need
    //     to reset the flag.
    //   - We also gate on a non-empty `tenantId` because the persist
    //     step targets the control-plane row anyway.
    //   - 4-char minimum on the user message so a stray "hi" / "?" /
    //     blank message doesn't burn a model call on garbage.
    if (!this._titleSummaryScheduled && tenantId) {
      const messages = this.getMessages?.() ?? [];
      const userMsgs = Array.isArray(messages)
        ? messages.filter((m) => (m as { role?: string }).role === "user")
        : [];
      if (userMsgs.length === 1) {
        const text = extractFirstUserText(userMsgs[0]);
        if (text && text.trim().length >= 4) {
          this._titleSummaryScheduled = true;
          this.ctx.waitUntil(
            summarizeAndPersistTitle(this.env, {
              chatId: this.name,
              tenantId,
              userId: this._currentTurnUserId ?? null,
              userMessageText: text,
              modelId: this._modelId,
              gatewayId: this.env.AI_GATEWAY_ID ?? null,
              broadcast: (m) => this.broadcast(m),
              onApplied: (newTitle) => {
                if (this._cachedChatContext) {
                  this._cachedChatContext.chatTitle = newTitle;
                }
              },
            }).catch(() => {
              // summarizeAndPersistTitle catches all errors internally
              // and logs them; this is purely a belt-and-braces guard
              // against an unexpected throw escaping waitUntil.
            })
          );
        }
      }
    }

    return { system: buildSystemPrompt(this._cachedChatContext) };
  }

  /**
   * Run the rate-limit policy. Opens a short-lived control-plane
   * connection to query `audit_log` counts. Cached via the same
   * lazy-resolve pattern as the chat context — we always use the
   * authoritative DB rather than DO storage so the limit is
   * consistent across replicas / restarts.
   */
  private async checkRateLimits(tenantId: string) {
    const { createDbClient } = await import("@data-agent/db");
    const url = await readSecret(this.env.CONTROL_PLANE_DB_URL);
    const { db, client } = createDbClient({ url, max: 1 });
    try {
      return await checkRateLimits(db, {
        tenantId,
        userId: this._currentTurnUserId,
        chatId: this.name,
      });
    } finally {
      // Connection close runs in waitUntil so we don't block the
      // turn on it. The pool was opened with max=1, no leakage.
      this.ctx.waitUntil(client.end({ timeout: 1 }).catch(() => {}));
    }
  }

  /**
   * Cost telemetry (5bcb5f) — we route every Workers AI call through
   * **Cloudflare AI Gateway** (`AI_GATEWAY_ID`, default `data-agent`).
   * The gateway dashboard owns:
   *   - per-model pricing (no hand-maintained tables)
   *   - per-request cost aggregation
   *   - prompt/response logs + replay
   *   - cache hit/miss accounting (we set `cf-aig-metadata` so the
   *     dashboard can slice cost per tenant/chat/user)
   *
   * What we still keep on our side is the **token totals per turn**:
   * (a) cheap to record, (b) gives forensics if the gateway log ever
   * disappears, and (c) lets us correlate audit rows with a specific
   * turn without round-tripping the gateway logs API. We deliberately
   * do **not** compute $-cost ourselves anymore — that was a
   * maintenance burden and double-source-of-truth for nothing.
   */
  private _currentTurnTokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
    steps: number;
  } = this._zeroTokens();

  private _zeroTokens(): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
    steps: number;
  } {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      steps: 0,
    };
  }

  /**
   * Per-step usage capture. Think (via the AI SDK) fires `onStepFinish`
   * after each LLM step with a `usage` object whose exact field names
   * vary by provider. Workers AI exposes
   * `{ inputTokens, outputTokens, totalTokens, reasoningTokens?,
   *    cachedInputTokens? }`. We only sum what we got — missing
   * fields stay at 0 — so a provider that returns nothing produces a
   * harmless all-zero row instead of a NaN-poisoned one.
   */
  override async onStepFinish(ctx: { usage?: unknown }): Promise<void> {
    const u = ctx?.usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          reasoningTokens?: number;
          cachedInputTokens?: number;
        }
      | undefined;
    if (!u) return;
    const t = this._currentTurnTokens;
    t.inputTokens += u.inputTokens ?? 0;
    t.outputTokens += u.outputTokens ?? 0;
    t.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    t.reasoningTokens += u.reasoningTokens ?? 0;
    t.cachedInputTokens += u.cachedInputTokens ?? 0;
    t.steps += 1;

    // Streaming-debug observability: emit a step span with cumulative
    // tokens + how long since the turn started. If a turn aborts, the
    // last logged step tells us how far the model got. Combined with
    // `chat.turn_chunk` heartbeats this triangulates *where* a stall
    // happens (between steps vs. mid-step vs. mid-tool).
    this._stepCount += 1;
    logEvent({
      event: "chat.turn_step",
      chatId: this.name,
      turnId: this._turnId,
      stepIndex: t.steps,
      stepTokensIn: u.inputTokens ?? 0,
      stepTokensOut: u.outputTokens ?? 0,
      cumulativeTokensIn: t.inputTokens,
      cumulativeTokensOut: t.outputTokens,
      cachedInputTokens: u.cachedInputTokens ?? 0,
      msSinceTurnStart: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : null,
      msSinceLastChunk: this._lastChunkAt > 0 ? Date.now() - this._lastChunkAt : null,
      lastChunkType: this._lastChunkType,
      chunkCount: this._chunkCount,
    });
  }

  /**
   * Per-chunk hook (streaming-debug). High-frequency: this fires per
   * token/event from the model stream. We use it as a heartbeat —
   * stamping `_lastChunkAt` lets `chat.turn_step` and
   * `chat.turn_complete` report "ms since last chunk", which
   * pinpoints whether an abort happened mid-stream (model went
   * silent) vs. between sub-requests (network hiccup).
   *
   * We log a sample (1 in 50) so high-volume streams don't spam
   * Workers Logs, but the heartbeat fields update on every chunk.
   */
  override async onChunk(ctx: { chunk?: { type?: string } }): Promise<void> {
    const type = ctx?.chunk?.type ?? "unknown";
    this._lastChunkAt = Date.now();
    this._lastChunkType = type;
    this._chunkCount += 1;
    // Log every 50th chunk + always log non-text-delta chunks (tool
    // input/result/finish). text-delta is the bulk so suppression
    // there saves the most.
    if (type !== "text-delta" || this._chunkCount % 50 === 0) {
      logEvent({
        event: "chat.turn_chunk",
        level: "debug",
        chatId: this.name,
        turnId: this._turnId,
        chunkType: type,
        chunkIndex: this._chunkCount,
        msSinceTurnStart: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : null,
      });
    }
  }

  /**
   * Audit hook (1dd311 + 5bcb5f) — fired by Think after the model
   * finishes a turn. Persists the accumulated token usage for the
   * `turn.complete` audit row, then resets the counter so the next
   * turn starts clean. Best-effort: a failed audit write must not
   * block the user's response.
   *
   * The audit `payload.gateway` field carries `{ id, model }` — when
   * combined with the timestamp this is enough to deep-link an audit
   * row into the Cloudflare AI Gateway logs view.
   */
  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const tenantId = this._cachedChatContext?.tenantId;
    const tokens = { ...this._currentTurnTokens };
    const durationMs = this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : null;
    // Reset BEFORE the await — next turn could start before the audit
    // insert completes, and we don't want carryover.
    this._currentTurnTokens = this._zeroTokens();
    this._turnStartedAt = 0;

    // Observability span (9fa055) — fires for *every* completed turn,
    // even when no tenant is resolvable (so we can debug bad routing).
    // status: "completed" | "aborted" | "error".
    const msSinceLastChunk = this._lastChunkAt > 0 ? Date.now() - this._lastChunkAt : null;
    logEvent({
      event: "chat.turn_complete",
      chatId: this.name,
      tenantId: tenantId ?? null,
      userId: this._currentTurnUserId ?? null,
      status: result.status,
      durationMs,
      model: this._modelId,
      gatewayId: this.env.AI_GATEWAY_ID ?? null,
      tokens,
      turnId: this._turnId,
      stepCount: this._stepCount,
      chunkCount: this._chunkCount,
      lastChunkType: this._lastChunkType,
      msSinceLastChunk,
      toolCalls: [...this._toolCalls],
      connections: countConnections(this),
      // Aborts in particular: which side aborted? If the WS already
      // closed before this fires, count == 0 → client disconnected.
      // If count > 0, server-side abort (signal fired internally).
      abortLikelyFrom:
        result.status === "aborted"
          ? countConnections(this) === 0
            ? "client_disconnect"
            : "server_signal"
          : null,
    });

    if (!tenantId) return;
    this.ctx.waitUntil(
      auditFromAgent(this.env, {
        tenantId,
        chatId: this.name,
        userId: this._currentTurnUserId ?? null,
        action: "turn.complete",
        target: this.name,
        payload: {
          status: result.status,
          tokens,
          durationMs,
          gateway: {
            id: this.env.AI_GATEWAY_ID ?? null,
            model: this._modelId,
          },
        },
      })
    );
  }

  /**
   * Model id this DO is currently running, for cost attribution and
   * gateway-log linking. Defaults to `DEFAULT_MODEL`; `getModel()`
   * updates it before each turn so the value is always current
   * relative to the most recent inference.
   */
  private _modelId: string = DEFAULT_MODEL;

  /** Wall-clock start of the current turn (9fa055). */
  private _turnStartedAt: number = 0;

  /**
   * Per-turn observability state (9fa055 / streaming-debug).
   *
   * `turnId` is a short opaque id stamped on every event in a turn
   * so Workers Logs can join `chat.turn_start`, every `chat.turn_step`,
   * a sample of `chat.turn_chunk`, the final
   * `chat.turn_complete`/`chat.turn_error`, and any `chat.ws.close`
   * that happens while the turn is in flight.
   *
   * `lastChunkAt`/`lastChunkType` give us the heartbeat — if the
   * turn aborts we report the gap since the last chunk, which
   * pinpoints whether the model went silent vs. the WS dropped vs.
   * a tool call hung.
   */
  private _turnId: string | null = null;
  private _lastChunkAt: number = 0;
  private _lastChunkType: string | null = null;
  private _chunkCount: number = 0;
  private _stepCount: number = 0;
  private _toolCalls: string[] = [];

  /**
   * Turn-error hook (1dd311 + streaming-debug).
   *
   * Captures the maximum diagnostics we can squeeze out of the
   * failure path. Three things matter beyond the error itself:
   *
   *   1. **Error class** — `AbortError`, `TypeError`, regular `Error`
   *      → tells us if it was an abort vs. a real error.
   *   2. **`error.cause` chain** — the AI SDK wraps fetch failures
   *      with `cause`; we walk one level so e.g. `Network request
   *      failed → cause: TLS reset` is visible.
   *   3. **What was streaming when it failed** — last chunk type,
   *      ms since last chunk, step count, tool-call sequence. This
   *      is what tells us "the model went silent at step 5 mid-tool"
   *      vs. "the WS dropped between step 3 and step 4".
   */
  override onChatError(error: unknown): unknown {
    const tenantId = this._cachedChatContext?.tenantId;
    const durationMs = this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : null;
    const msSinceLastChunk = this._lastChunkAt > 0 ? Date.now() - this._lastChunkAt : null;

    const errInfo = describeError(error);
    const turnId = this._turnId;
    const stepCount = this._stepCount;
    const chunkCount = this._chunkCount;
    const lastChunkType = this._lastChunkType;
    const toolCalls = [...this._toolCalls];

    // Reset turn timer so a follow-on turn can't measure against
    // the failed one. (Heartbeat fields are reset in beforeTurn.)
    this._turnStartedAt = 0;

    // Observability span (9fa055).
    logEvent({
      event: "chat.turn_error",
      level: "error",
      chatId: this.name,
      tenantId: tenantId ?? null,
      userId: this._currentTurnUserId ?? null,
      durationMs,
      model: this._modelId,
      turnId,
      // Triangulation fields — *where* in the turn the failure hit.
      stepCount,
      chunkCount,
      lastChunkType,
      msSinceLastChunk,
      toolCalls,
      connections: countConnections(this),
      // Error shape.
      errorName: errInfo.name,
      errorMessage: errInfo.message,
      errorCause: errInfo.cause,
      isAbort: errInfo.isAbort,
    });

    if (tenantId) {
      this.ctx.waitUntil(
        auditFromAgent(this.env, {
          tenantId,
          chatId: this.name,
          userId: this._currentTurnUserId ?? null,
          action: "turn.error",
          target: this.name,
          payload: {
            error: errInfo.message.slice(0, 500),
            errorName: errInfo.name,
            errorCause: errInfo.cause,
            isAbort: errInfo.isAbort,
            turnId,
            stepCount,
            chunkCount,
            lastChunkType,
            msSinceLastChunk,
            durationMs,
          },
        })
      );
    }
    return error;
  }

  /** Tracks the user driving the current turn for audit attribution. */
  private _currentTurnUserId: string | null = null;

  /**
   * Per-DO flag for the title auto-summarizer (subtask 16656a). Set
   * once we kick off the first-user-message summary; never reset.
   * Cross-DO-instance protection comes from the persisted message
   * history (a hibernation + revive will see >1 user message and skip).
   * Cross-chat protection comes from this being a per-DO field — and
   * one DO == one chat in our routing.
   */
  private _titleSummaryScheduled: boolean = false;

  /**
   * Audit hook (1dd311) — fires after every tool call (success or
   * failure). We only persist a row for security-relevant tools and
   * include just enough payload to be useful in an audit trail
   * without leaking data.
   */
  override async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    const tenantId = this._cachedChatContext?.tenantId;
    const name = ctx.toolName;

    // Track per-turn tool sequence for streaming-debug. Capped at
    // 50 entries to keep memory bounded across pathological loops.
    if (this._toolCalls.length < 50) {
      this._toolCalls.push(`${name}${ctx.success ? "" : "!"}`);
    }

    // Observability span (9fa055) — fires for every tool call, even
    // un-audited ones. Lets us spot pathological model behavior
    // (e.g. spinning on chart tools, oscillating between db_query
    // variants) without enabling debug-level logging.
    logEvent({
      event: "chat.tool_call",
      level: ctx.success ? "info" : "warn",
      chatId: this.name,
      tenantId: tenantId ?? null,
      userId: this._currentTurnUserId ?? null,
      turnId: this._turnId,
      tool: name,
      success: ctx.success,
      durationMs: ctx.durationMs,
      msSinceTurnStart: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : null,
    });

    if (!tenantId) return;
    // Only audit a curated set: data access + persistence. Sandbox
    // execution itself isn't a separate audit event — `turn.complete`
    // already captures that the turn ran.
    const isAuditable =
      name === "db_query" ||
      name === "db_introspect" ||
      name.startsWith("artifact_write") ||
      name === "chart_save";
    if (!isAuditable) return;

    let payload: Record<string, unknown> | null = null;
    try {
      if (name === "db_query") {
        const input = ctx.input as { sql?: string; params?: unknown[] };
        const output = ctx.output as { rows?: unknown[]; truncated?: boolean } | undefined;
        const sqlHash = input?.sql ? await hashSql(input.sql) : null;
        payload = {
          sqlHash,
          paramsCount: Array.isArray(input?.params) ? input!.params!.length : 0,
          rowCount: Array.isArray(output?.rows) ? output!.rows!.length : null,
          truncated: output?.truncated ?? null,
          success: ctx.success,
          durationMs: ctx.durationMs,
        };
      } else {
        payload = {
          success: ctx.success,
          durationMs: ctx.durationMs,
          input: safePayload(ctx.input as Record<string, unknown>, 800),
        };
      }
    } catch {
      payload = { success: ctx.success };
    }

    this.ctx.waitUntil(
      auditFromAgent(this.env, {
        tenantId,
        chatId: this.name,
        userId: this._currentTurnUserId ?? null,
        action: name === "db_query" ? "db.query" : `tool.${name}`,
        target: ctx.toolCallId,
        payload,
      })
    );
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
          tenantId: schema.chat.tenantId,
          dbProfileId: schema.chat.dbProfileId,
        })
        .from(schema.chat)
        .where(eq(schema.chat.id, this.name))
        .limit(1);

      const ctx: ChatContext = {
        chatTitle: chat?.title,
        tenantId: chat?.tenantId,
        dbProfileId: chat?.dbProfileId ?? null,
      };
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

    // Streaming-debug: log every WS attach so we can correlate with
    // turn aborts. The `connectionId` lets us group ws.connect with
    // the corresponding ws.close even when multiple users share a
    // chat.
    logEvent({
      event: "chat.ws.connect",
      chatId: this.name,
      userId,
      tenantId,
      connectionId: connection.id,
      activeConnections: countConnections(this),
    });
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    type PresenceState = { userId?: string; tenantId?: string; joinedAt?: number };
    const state = connection.state as PresenceState | undefined;
    const sessionMs = state?.joinedAt && state.joinedAt > 0 ? Date.now() - state.joinedAt : null;

    // Streaming-debug: this is the single most useful event when
    // diagnosing "why did my turn abort". WebSocket close codes:
    //   1000 normal closure
    //   1001 going away (browser tab/page closed) — common
    //   1006 abnormal — connection lost, no close frame (network
    //        flap, tab crash). This is what we saw on chat 62605d6f.
    //   1011 server error
    //   1012 service restart
    //   4xxx application-defined (think uses 1000/1001 mostly)
    //
    // We deliberately log this BEFORE super.onClose so the in-flight
    // turn id (if any) is still bound. (Think's onClose only resets
    // continuation state, doesn't touch our `_turnId`.)
    logEvent({
      event: "chat.ws.close",
      level: wasClean ? "info" : "warn",
      chatId: this.name,
      userId: state?.userId ?? null,
      tenantId: state?.tenantId ?? null,
      connectionId: connection.id,
      code,
      reason: reason ? reason.slice(0, 200) : "",
      wasClean,
      sessionMs,
      // If there's an active turn, this close is *almost certainly*
      // why it'll be reported as aborted.
      activeTurnId: this._turnId,
      msSinceLastChunk: this._lastChunkAt > 0 ? Date.now() - this._lastChunkAt : null,
      remainingConnections: Math.max(0, countConnections(this) - 1),
    });

    await super.onClose(connection, code, reason, wasClean);
    // Connection is already removed from `getConnections()` by the time
    // onClose runs, so the broadcast naturally reflects the new state.
    this.broadcastPresence();
  }

  /**
   * Audit attribution (1dd311) — stamp the user id of whichever
   * connection drove the most recent message onto the agent. Think's
   * turn pipeline reads `_currentTurnUserId` in `beforeTurn` /
   * `onChatResponse` / `onChatError` and writes it into the audit row.
   *
   * For single-user chats this is exact. For multi-user chats it's
   * "the user who sent the message", which is what we want — even if
   * a different user happened to have a connection open at the same
   * moment.
   */
  override async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    type PresenceState = { userId?: string };
    const userId = (connection.state as PresenceState | undefined)?.userId;
    if (userId) this._currentTurnUserId = userId;
    await super.onMessage(connection, message);
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
   * Debug RPC — dumps the agent's persisted message history + a few
   * pieces of runtime state so a chat that "looks empty" to the user
   * can be inspected from a script. Returns a JSON-serializable shape
   * truncated to keep response size reasonable.
   *
   * Intentionally keeps the contract loose (returns `unknown[]`) so we
   * can iterate on the dump shape without breaking spike tooling.
   */
  /**
   * Debug RPC — wipe the persisted message history for this chat. Use
   * to recover from a stuck/corrupted assistant message (e.g. the
   * model crashed mid-stream and left a `state: streaming` part). The
   * client UI replays from this DO's SQL on every reconnect, so after
   * this call a fresh WS connect shows an empty chat.
   *
   * Returns the number of messages removed so callers can sanity-check.
   */
  @callable()
  async debugClearMessages(): Promise<{ ok: true; removed: number }> {
    const before = this.getMessages?.() ?? [];
    this.clearMessages?.();
    return { ok: true, removed: Array.isArray(before) ? before.length : 0 };
  }

  /**
   * Debug RPC — return the current rate-limit usage for this chat
   * (947c38). Useful from a script when a user reports being blocked
   * unexpectedly. Returns a structured per-window snapshot of
   * (current, max, windowMs, code) and the overall decision.
   */
  @callable()
  async debugRateLimits(): Promise<{
    ok: boolean;
    decision: { ok: boolean; code?: string; current?: number; max?: number; windowMs?: number };
    tenantId: string | null;
  }> {
    const tenantId = this._cachedChatContext?.tenantId;
    if (!tenantId) {
      // No chat context resolved yet — surface the gap so the caller
      // knows why we can't evaluate.
      return {
        ok: false,
        decision: { ok: false, code: "no_chat_context" },
        tenantId: null,
      };
    }
    const decision = await this.checkRateLimits(tenantId);
    return { ok: decision.ok, decision, tenantId };
  }

  @callable()
  async debugDump(opts?: { limit?: number }): Promise<{
    chatId: string;
    persistedMessageCount: number;
    messages: unknown[];
    cachedChatContext: ChatContext | undefined;
    currentTurnUserId: string | null;
    presence: { userId: string; joinedAt: number }[];
  }> {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const all = this.getMessages?.() ?? [];
    const tail = Array.isArray(all) ? all.slice(-limit) : [];
    type PresenceState = { userId: string; joinedAt: number };
    const presence: { userId: string; joinedAt: number }[] = [];
    for (const conn of this.getConnections<PresenceState>()) {
      if (conn.state) presence.push({ userId: conn.state.userId, joinedAt: conn.state.joinedAt });
    }
    return {
      chatId: this.name,
      persistedMessageCount: Array.isArray(all) ? all.length : 0,
      messages: tail,
      cachedChatContext: this._cachedChatContext,
      currentTurnUserId: this._currentTurnUserId,
      presence,
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
   * Hardening probes — verify the sandbox really enforces what we claim
   * (subtask 2173ac). Each probe runs a small piece of code via the
   * Dynamic Worker executor and reports whether the expected guard
   * actually fired.
   *
   * We expose these as @callable RPCs so they're executable from the
   * spike harness on every deploy, ensuring the hardening doesn't
   * silently regress (e.g. Worker Loader changing defaults).
   */
  @callable()
  async sandboxNetworkProbe(): Promise<{
    fetchBlocked: boolean;
    connectBlocked: boolean;
    error?: string;
  }> {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER as never,
      timeout: 5_000,
      globalOutbound: null,
    });
    // Single piece of code that tries fetch() and a TCP connect-like
    // import. If either succeeds, our isolation has failed.
    const code = `
      async () => {
        const result = { fetchBlocked: false, connectBlocked: false };
        try {
          const r1 = await fetch("https://example.com");
          // If we got here, the call returned — record the status so
          // we can see whether outbound went somewhere.
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
   * Run the sandbox with a tight 1.5 s timeout against an infinite
   * loop, then verify the executor returned an error or empty result
   * within ~2 s. Catches a regression where the timeout option is
   * silently ignored.
   */
  @callable()
  async sandboxTimeoutProbe(): Promise<{
    timedOut: boolean;
    durationMs: number;
    errorPreview?: string;
  }> {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER as never,
      timeout: 1_500,
      globalOutbound: null,
    });
    // We avoid a tight CPU loop because Workers Loader bills sandbox
    // CPU against the parent isolate. Instead, await a never-resolving
    // promise — the executor's wall-clock timeout should still fire.
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
