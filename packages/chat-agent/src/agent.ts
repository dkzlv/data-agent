import { callable, type Connection, type ConnectionContext } from "agents";
import { Think, type ChatResponseResult, type ToolCallResultContext } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";
import type { LanguageModel, ToolSet } from "ai";
import { logEvent, truncateMessage } from "@data-agent/shared";
import { runRateLimitCheck, RateLimitError } from "./rate-limits";
import { type DataDbHandle } from "./data-db";
import { buildSystemPrompt, type ChatContext } from "./system-prompt";
import { scheduleTitleSummary } from "./title-summarizer";
import { readSecret, type Env } from "./env";
import { TurnState } from "./turn-state";
import { TurnLogger } from "./turn-logger";
import { countConnections } from "./obs-helpers";
import { handleArtifactRequest } from "./http-artifacts";
import { buildChatModel, DEFAULT_MODEL } from "./model-factory";
import { ChatContextStore } from "./chat-context";
import { TurnPipeline } from "./turn-pipeline";
import {
  attachConnection,
  buildPresencePayload,
  currentUserIdFromConnection,
  detachConnection,
  type PresenceState,
} from "./presence";
import { buildAgentTools } from "./tools/build";
import { repairDanglingToolParts } from "./repair-history";
import type { AgentHost } from "./agent-host";
import * as debug from "./debug-rpcs";

const CODEMODE_DESCRIPTION_PREPEND =
  "USE THIS TOOL whenever you need to introspect the schema, " +
  "run SQL, save a chart, write an artifact, or do any other " +
  "real work for the user. Pass the JavaScript arrow function " +
  "as the `code` argument. NEVER reply to the user with code in " +
  "plain text — that is a wasted turn. If you are about to write " +
  "`async () => { ... }` in your assistant message, stop and call " +
  "this tool instead. Only write prose to the user *after* the " +
  "tool has run, summarizing what you found.";

/**
 * ChatAgent — extends `Think`, the AI-chat-aware Agent base.
 *
 * **Read this file top-to-bottom as a turn pipeline.** Each Think
 * lifecycle hook below is a one- or two-line delegation; the actual
 * orchestration lives in `turn-pipeline.ts`, the per-turn state in
 * `turn-state.ts`, presence in `presence.ts`, tools in `tools/build.ts`,
 * the chat context cache in `chat-context.ts`. Everything here is a
 * TOC entry into one of those modules.
 *
 * Persistence (subtask 382d1f):
 *   `Think` persists every turn into this DO's SQLite via the
 *   `cf_agent_chat_messages` protocol. On every WS connect the server
 *   replays the full history to the client. Verified by `scripts/spike.ts`.
 *
 * Resumable streaming (subtask 382d1f):
 *   On client mid-turn disconnect, the model continues; the client
 *   reconnects and sends `cf_agent_stream_resume_request`, server
 *   replies with `cf_agent_stream_resuming` and replays buffered
 *   chunks. Free from `Think`'s `ContinuationState`.
 *
 * Cross-chat isolation comes from DO name routing (one DO per chat).
 * Persistence is anchored to `this.name`.
 */
export class ChatAgent extends Think<Env> implements AgentHost {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.ARTIFACTS,
    name: () => this.name,
  });

  // --- AgentHost surface -------------------------------------------------

  /** Per-turn state machine. Reused across turns; `start()` resets atomically. */
  readonly turn = new TurnState();

  /** Bound logger — folds chatId/tenantId/userId/turnId into every event. */
  readonly turnLog = new TurnLogger(this.env, this, () => ({
    connections: countConnections(this),
  }));

  /** Lazy chat-context store (title, attached dbProfile). See chat-context.ts. */
  readonly chatContext = new ChatContextStore(this.env, this.name);

  /** Mutable holder for the user's Postgres pool — see data-db.ts. */
  readonly dataDbCache: DataDbHandle = {};

  /**
   * The user who sent the last message. Used for audit attribution.
   * Earlier this was named `_currentTurnUserId`; renamed because in
   * multi-user chats there is no single "driver" — it's the last
   * sender.
   */
  lastSenderUserId: string | null = null;

  /** Model id stamped by `getModel()`. Public so the pipeline reads it. */
  currentModelId: string = DEFAULT_MODEL;

  /**
   * Resolved CF AI Gateway bearer for this DO instance. Populated in
   * the constructor via `blockConcurrencyWhile` so the *sync*
   * `getModel()` doesn't have to await secrets. Stays in memory for
   * the DO lifetime; evicted on hibernation.
   *
   * Null means: not yet resolved, or the binding is unset in local
   * dev — the model call will 401 loudly, which is the right signal.
   */
  private resolvedAigToken: string | null = null;

  /**
   * Per-DO flag for the title auto-summarizer (subtask 16656a). Set
   * once we kick off the first-user-message summary; never reset.
   * Cross-DO-instance protection comes from the persisted message
   * history (a hibernation + revive will see >1 user message and skip).
   */
  private titleScheduled = false;

  // --- Envelope getters (read by TurnLogger via EnvelopeProvider) -------

  get chatId(): string {
    return this.name;
  }
  get tenantId(): string | null {
    return this.chatContext.peek()?.tenantId ?? null;
  }
  get userId(): string | null {
    return this.lastSenderUserId;
  }
  get turnId(): string | null {
    return this.turn.turnId;
  }

  // --- AgentHost methods ------------------------------------------------

  /** Public env accessor — `env` is `protected` on the base class. */
  getEnv(): Env {
    return this.env;
  }
  getPersistedMessages(): unknown[] {
    const all = this.getMessages();
    return Array.isArray(all) ? all : [];
  }
  clearPersistedMessages(): void {
    this.clearMessages();
  }

  // --- Pipeline ---------------------------------------------------------

  private readonly pipeline = new TurnPipeline(this.turn, this.turnLog, {
    connectionCount: () => countConnections(this),
    gatewayId: () => this.env.AI_GATEWAY_ID ?? null,
    waitUntil: (p) => this.ctx.waitUntil(p),
    chatId: () => this.name,
    tenantId: () => this.tenantId,
    stampReasoningElapsed: (ms) => this.stampReasoningElapsed(ms),
  });

  /**
   * Resolve the AI Gateway bearer eagerly at DO construction. This is
   * the only secret `getModel()` needs, and `getModel()` is sync and
   * runs *before* `beforeTurn` (Think framework calls it on the
   * inbound path). `ctx.blockConcurrencyWhile` blocks all incoming
   * requests/RPCs to this DO instance until the resolution finishes —
   * canonical pattern for one-shot async setup. Resolution is
   * typically <50ms (Secrets Store value fetch).
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (env.CF_AIG_TOKEN) {
        try {
          this.resolvedAigToken = await readSecret(env.CF_AIG_TOKEN);
        } catch (err) {
          logEvent({
            event: "chat.aig_token_resolve_failed",
            level: "warn",
            chatId: this.name,
            error: truncateMessage(err),
          });
        }
      }
    });
  }

  // --- Think lifecycle (read top-to-bottom as a turn) -------------------

  override getModel(): LanguageModel {
    const { modelId, model } = buildChatModel({
      env: this.env,
      chatId: this.name,
      tenantId: this.tenantId,
      userId: this.userId,
      sessionAffinity: this.sessionAffinity,
      resolvedAigToken: this.resolvedAigToken,
    });
    this.currentModelId = modelId;
    return model;
  }

  /**
   * @deprecated Used as a defensive fallback only — `beforeTurn` now
   *   returns `{ system }` on the production path. Kept until we've
   *   verified across two releases that nothing reaches this branch
   *   (no `chat.system_prompt_fallback` log fires).
   */
  override getSystemPrompt(): string {
    logEvent({
      event: "chat.system_prompt_fallback",
      level: "debug",
      chatId: this.name,
    });
    return buildSystemPrompt(this.chatContext.peek());
  }

  /**
   * Per-turn: history-repair pass, gate rate limit, stamp turn start,
   * schedule auto-title (first turn only), inject the system prompt.
   * Falls back gracefully if the control-plane is unreachable — we
   * never block a turn on prompt decoration.
   */
  override async beforeTurn(): Promise<void | { system: string }> {
    this.repairDanglingHistory();

    const ctx = await this.chatContext.get();
    await this.gateRateLimit(ctx?.tenantId ?? null);

    this.pipeline.start({
      dbProfileId: ctx?.dbProfileId ?? null,
      modelId: this.currentModelId,
      userId: this.lastSenderUserId,
    });

    if (!this.titleScheduled) {
      const result = scheduleTitleSummary({
        env: this.env,
        chatId: this.name,
        tenantId: ctx?.tenantId ?? null,
        alreadyScheduled: this.titleScheduled,
        messages: this.getPersistedMessages(),
        userId: this.lastSenderUserId,
        modelId: this.currentModelId,
        gatewayId: this.env.AI_GATEWAY_ID ?? null,
        broadcast: (m) => this.broadcast(m),
        onApplied: (t) => this.chatContext.setTitle(t),
        waitUntil: (p) => this.ctx.waitUntil(p),
        logSkip: (reason, textLen) =>
          this.turnLog.event("chat.title_summarize_skipped", {
            level: reason === "tenant_unresolved" ? "warn" : "info",
            reason,
            ...(typeof textLen === "number" ? { textLen } : {}),
          }),
      });
      if (result.scheduled) this.titleScheduled = true;
    }

    return { system: buildSystemPrompt(ctx) };
  }

  override async onStepFinish(ctx: { usage?: unknown }): Promise<void> {
    this.pipeline.step(ctx?.usage as Parameters<TurnPipeline["step"]>[0]);
  }

  override async onChunk(ctx: { chunk?: { type?: string } }): Promise<void> {
    this.pipeline.chunk(ctx?.chunk?.type);
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    this.pipeline.complete(result, this.currentModelId);
  }

  override onChatError(error: unknown): unknown {
    this.pipeline.error(error, this.currentModelId);
    return error;
  }

  override async afterToolCall(ctx: ToolCallResultContext): Promise<void> {
    await this.pipeline.toolCall(ctx);
  }

  override getTools(): ToolSet {
    return buildAgentTools({
      env: this.env,
      host: this,
      descriptionPrepend: CODEMODE_DESCRIPTION_PREPEND,
      onCodemodeEvent: (ev) => {
        if (ev.kind === "truncated") {
          this.turnLog.event("chat.codemode_result_truncated", {
            level: "warn",
            originalChars: ev.originalChars,
            cap: ev.cap,
          });
        } else if (ev.kind === "sandbox_error") {
          this.turnLog.event("chat.codemode_sandbox_error", {
            level: "warn",
            message: ev.message,
          });
        }
      },
    });
  }

  // --- WS / messaging ---------------------------------------------------

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // Always send a `cf_agent_chat_messages` snapshot first.
    //
    // Think (think.js:983-989, 0.4.2) wraps user `onConnect` and
    // gates the snapshot send on `hasActiveStream()`: if a turn is
    // mid-flight, it sends `cf_agent_stream_resuming` *instead of*
    // a snapshot. That leaves a refreshing client with no history
    // to render the resumed stream chunks into — the user sees an
    // empty list with the streaming assistant message growing while
    // every prior turn is gone until completion. Canonical repro:
    // chat 3a76a225 (task bf7ab7).
    //
    // Sending the snapshot ourselves before deferring to super
    // unconditionally fills that gap. In the no-active-stream
    // branch Think's wrapper still sends its own snapshot, so the
    // client gets the same payload twice — `useAgentChat` calls
    // `setMessages(snapshot)` either way and the second call is a
    // no-op (same content, same identity). Tested in the field;
    // zero behavioral cost on the common path.
    //
    // We use the wire constant `cf_agent_chat_messages` (from
    // `agents/chat`'s `CHAT_MESSAGE_TYPES.CHAT_MESSAGES`) — that's
    // what Think serializes and what `@cloudflare/ai-chat`
    // recognizes on the client.
    let snapshotSent = false;
    let snapshotMessageCount = 0;
    let hasActiveStream = false;
    try {
      hasActiveStream = this._resumableStream?.hasActiveStream?.() ?? false;
      const messages = this.getMessages?.() ?? [];
      snapshotMessageCount = Array.isArray(messages) ? messages.length : 0;
      connection.send(
        JSON.stringify({
          type: "cf_agent_chat_messages",
          messages,
        })
      );
      snapshotSent = true;
    } catch (err) {
      // Snapshot is best-effort. If the connection is already in a
      // bad state, Think's own snapshot path (or the next reconnect)
      // will recover. Don't fail the whole connect.
      logEvent({
        event: "chat.snapshot_send_failed",
        level: "warn",
        chatId: this.name,
        error: truncateMessage(err),
      });
    }

    if (snapshotSent) {
      logEvent({
        event: "chat.snapshot_sent",
        level: "debug",
        chatId: this.name,
        messageCount: snapshotMessageCount,
        hasActiveStream,
      });
    }

    // Defer to Think's onConnect (it sends a snapshot OR the
    // stream-resuming notification, then runs the user-overridable
    // body — which is empty on the base class).
    await super.onConnect(connection, ctx);
    attachConnection(connection, ctx, {
      chatId: this.name,
      activeConnections: countConnections(this),
    });
    this.broadcastPresence();
  }

  override async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Log BEFORE super.onClose so the in-flight turn id is still
    // bound when we serialize the close event.
    detachConnection(connection, {
      chatId: this.name,
      code,
      reason,
      wasClean,
      turn: this.turn,
      remainingConnections: Math.max(0, countConnections(this) - 1),
    });
    await super.onClose(connection, code, reason, wasClean);
    this.broadcastPresence();
  }

  /**
   * Stamp the user id of whichever connection drove the most recent
   * message. Also peeks for `cf_agent_chat_request_cancel` frames so
   * we can attribute future `status: "aborted"` outcomes to the
   * client's stop button vs a server-internal abort (chat e05ce53c).
   *
   * For multi-user chats `lastSenderUserId` is "the user who sent
   * THIS message", which is what we want for attribution.
   */
  override async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    const userId = currentUserIdFromConnection(connection);
    if (userId) this.lastSenderUserId = userId;

    // Cancel-frame triage. Only inspect string frames (cancel envelope
    // is JSON over text). Any parse failure is silently swallowed —
    // observability, not a gate. We MUST forward to super.onMessage
    // regardless so the SDK's own dispatch still runs.
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message) as { type?: unknown; id?: unknown };
        if (parsed && parsed.type === "cf_agent_chat_request_cancel") {
          this.turn.recordCancel(userId ?? "unknown");
          this.turnLog.event("chat.cancel_received", {
            level: "info",
            connectionId: connection.id,
            requestId: typeof parsed.id === "string" ? parsed.id : null,
            // Time-since-turn-start tells us *how long* the user
            // waited before bailing — useful for UX (e.g. "people
            // give up after ~10s of silent reasoning").
            msSinceTurnStart: this.turn.snapshot().durationMs,
            activeConnections: countConnections(this),
          });
        }
      } catch {
        // Non-JSON or unparseable; ignore. The SDK surfaces real
        // protocol errors via its own paths.
      }
    }

    await super.onMessage(connection, message);
  }

  /** HTTP handler for non-WS requests. Currently serves artifact bytes. */
  override async onRequest(request: Request): Promise<Response> {
    return handleArtifactRequest(this, request);
  }

  // --- Internal helpers --------------------------------------------------

  /**
   * Sweep half-baked tool-call parts left over from an aborted turn
   * (chats `236a4117` and `feca41d8` both hit this). Symptom: a
   * previous turn aborted mid-flight right after the model emitted a
   * tool call but before the sandbox produced a result. The persisted
   * assistant message contains a `tool-codemode` (or other) part stuck
   * in `state: "input-available"`. On the next turn the AI SDK
   * serializes that into a `tool_use` block with no matching
   * `tool_result` and the model rejects the prefix — the user sees the
   * generic "Something went wrong" banner with no recovery path.
   *
   * We replace each dangling part with a synthetic `output-error`
   * envelope (same shape as `wrapCodemodeTool`'s
   * `tool_call_interrupted` recoverable error). The model sees a
   * recoverable failure in its history and naturally retries on the
   * next turn — no message wipe, no user action needed.
   *
   * `session.updateMessage` is the lower-level mutation primitive
   * (in-memory Session + persisted SQL update). We use it instead of
   * `saveMessages` because the latter triggers a model turn, which
   * would race the in-flight one we're about to start.
   */
  private repairDanglingHistory(): void {
    try {
      const history = this.getMessages?.() ?? [];
      if (!Array.isArray(history) || history.length === 0) return;
      // Double-cast through `unknown`: `repairDanglingToolParts` is
      // intentionally typed against a loose shape so it stays pure /
      // unit-testable without dragging the AI SDK's generic
      // `UIMessage<unknown, UIDataTypes, UITools>` through this file.
      const result = repairDanglingToolParts(
        history as unknown as Parameters<typeof repairDanglingToolParts>[0]
      );
      if (result.repaired === 0) return;

      for (const detail of result.details) {
        const repaired = result.messages[detail.messageIndex];
        if (repaired && typeof (repaired as { id?: unknown }).id === "string") {
          this.session.updateMessage(
            repaired as unknown as Parameters<typeof this.session.updateMessage>[0]
          );
        }
      }
      logEvent({
        event: "chat.history_repaired",
        level: "warn",
        chatId: this.name,
        tenantId: this.chatContext.peek()?.tenantId ?? null,
        repairedCount: result.repaired,
        // Per-occurrence diagnostics so we can tell at a glance which
        // tool got cut off (db_query? introspect? chart?).
        details: result.details,
      });
    } catch (err) {
      // Repair is best-effort. Better to attempt the turn with a
      // (possibly broken) history than to fail the turn outright on
      // a defensive mutation pass.
      logEvent({
        event: "chat.history_repair_failed",
        level: "warn",
        chatId: this.name,
        error: truncateMessage(err),
      });
    }
  }

  /**
   * Stamp the measured reasoning duration onto the most recent
   * assistant message's reasoning part(s) so the web UI can render
   * "Thought for Ns" honestly on replay. Stored under
   * `providerMetadata.dataAgent.elapsedMs` because:
   *
   *   - `providerMetadata` is a first-class field on `ReasoningUIPart`;
   *     the AI SDK preserves arbitrary keys nested under it.
   *   - Namespacing under `dataAgent` keeps us out of any vendor's
   *     way (anthropic, openai both stash provider-specific fields here).
   *
   * Stamps the *last* reasoning part of the message — that's the one
   * this turn produced. Earlier reasoning parts belong to prior steps
   * and already have stamps from previous `onChatResponse` calls.
   *
   * Best-effort: failures only lose a UI label, never block the user's
   * response or the audit row.
   */
  private stampReasoningElapsed(elapsedMs: number): void {
    try {
      const messages = this.getMessages?.() ?? [];
      if (!Array.isArray(messages) || messages.length === 0) return;

      // Find the last assistant message — that's the one this turn
      // just produced.
      let lastAssistantIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string };
        if (m?.role === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      if (lastAssistantIdx < 0) return;

      const msg = messages[lastAssistantIdx] as {
        id?: string;
        role?: string;
        parts?: Array<{ type?: string; providerMetadata?: Record<string, unknown> }>;
      };
      if (typeof msg.id !== "string" || !Array.isArray(msg.parts)) return;

      let lastReasoningIdx = -1;
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        if (msg.parts[i]?.type === "reasoning") {
          lastReasoningIdx = i;
          break;
        }
      }
      if (lastReasoningIdx < 0) return;

      const target = msg.parts[lastReasoningIdx];
      if (!target) return;

      const prevMeta = target.providerMetadata ?? {};
      const prevDataAgent = (prevMeta.dataAgent as Record<string, unknown> | undefined) ?? {};
      const nextParts = msg.parts.slice();
      nextParts[lastReasoningIdx] = {
        ...target,
        providerMetadata: {
          ...prevMeta,
          dataAgent: { ...prevDataAgent, elapsedMs },
        },
      };
      const nextMsg = { ...msg, parts: nextParts };
      this.session.updateMessage(
        nextMsg as unknown as Parameters<typeof this.session.updateMessage>[0]
      );
    } catch (err) {
      this.turnLog.event("chat.reasoning_stamp_failed", {
        level: "warn",
        error: truncateMessage(err),
      });
    }
  }

  /**
   * Rate-limit gate (947c38). Runs *before* the audit insert so the
   * count reflects strictly previous turns. We only check when we
   * know the tenantId; un-resolvable chats have a different failure
   * mode (the LLM call itself will fail).
   *
   * Throws `RateLimitError` on hit — propagates to Think's error
   * pipeline, which calls our `onChatError` and surfaces a `turn.error`
   * audit row. Custom error class so the UX layer (subtask 2f89ff)
   * can render a dedicated "you've hit your limit" message.
   */
  private async gateRateLimit(tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    const decision = await runRateLimitCheck({
      env: this.env,
      chatId: this.name,
      tenantId,
      userId: this.lastSenderUserId,
      waitUntil: (p) => this.ctx.waitUntil(p),
    });
    if (!decision.ok) {
      throw new RateLimitError(decision.code, decision.max, decision.windowMs, decision.current);
    }
  }

  private broadcastPresence(): void {
    this.broadcast(buildPresencePayload(this.getConnections<PresenceState>()));
  }

  // --- @callable RPC stubs ----------------------------------------------
  // SDK requires `@callable()` decorators on the DO class itself; bodies
  // live in `debug-rpcs.ts`. Keep one-line stubs alphabetical.

  @callable() artifactToolsSmoke() {
    return debug.artifactToolsSmoke(this);
  }
  @callable() dataDbHealthcheck() {
    return debug.dataDbHealthcheck(this);
  }
  @callable() dataDbReset() {
    return debug.dataDbReset(this);
  }
  @callable() dbToolsSmoke() {
    return debug.dbToolsSmoke(this);
  }
  @callable() debugClearMessages() {
    return debug.debugClearMessages(this);
  }
  @callable() debugDump(opts?: { limit?: number }) {
    return debug.debugDump(this, opts);
  }
  @callable() debugRateLimits() {
    return debug.debugRateLimits(this);
  }
  @callable() debugTitleProbe(text: string) {
    return debug.debugTitleProbe(this, text);
  }
  @callable() healthcheck() {
    return debug.healthcheck(this);
  }
  @callable() sandboxNetworkProbe() {
    return debug.sandboxNetworkProbe(this);
  }
  @callable() sandboxTimeoutProbe() {
    return debug.sandboxTimeoutProbe(this);
  }

  /**
   * Set the chat context (title, attached database, current user) so
   * the system prompt can render an accurate per-chat header. Called
   * by the api-gateway right after a turn is initiated.
   *
   * Keeping this as an explicit RPC (rather than re-querying the
   * control-plane on every turn from inside the DO) avoids a Postgres
   * round-trip per turn — the gateway already has this info from
   * session validation.
   */
  @callable()
  async setChatContext(ctx: ChatContext): Promise<{ ok: true }> {
    this.chatContext.replace(ctx);
    return { ok: true };
  }
}
