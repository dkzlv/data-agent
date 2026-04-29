/**
 * Per-turn state machine for the ChatAgent.
 *
 * Earlier all 14 of these fields lived directly on the agent class
 * with three different reset sites (`beforeTurn`, `onChatResponse`,
 * `onChatError`). It was easy to introduce carry-over bugs (e.g.
 * step counters bleeding into the next turn). Centralizing here:
 *   - one `start()` zeroes everything atomically
 *   - heartbeat / step / tool / token mutations go through methods
 *     so a future field is added in one place
 *   - `snapshot()` returns a frozen copy for logging/audit so we
 *     can't accidentally hold a live reference and observe a reset
 *     mid-write.
 *
 * Pure data — no env / no IO. Trivially unit-testable.
 */
export interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  /**
   * Anthropic prompt-cache *write* — input tokens charged at the
   * 25% premium to populate the cache for this turn. Always 0 for
   * non-Anthropic providers. The metric a deploy-time observer
   * watches once after enabling caching: should be ~tools+system on
   * the *first* turn of a chat, then ~0 for follow-ups.
   */
  cacheCreationInputTokens: number;
  /**
   * Anthropic prompt-cache *read* — input tokens billed at 10% of
   * the regular input rate. Always 0 for non-Anthropic providers.
   * On steady-state turns this should approximate the previous
   * turn's `inputTokens` minus whatever rolled into the new prefix.
   */
  cacheReadInputTokens: number;
  steps: number;
}

export interface TurnUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface TurnSnapshot {
  turnId: string | null;
  startedAt: number;
  userId: string | null;
  lastChunkAt: number;
  lastChunkType: string | null;
  chunkCount: number;
  stepCount: number;
  toolCalls: string[];
  tokens: TurnTokens;
  /** ms elapsed since `startedAt`, or null if no turn is active. */
  durationMs: number | null;
  /** ms since the last chunk landed, or null if none yet. */
  msSinceLastChunk: number | null;
  /** Accumulated wall-clock spent emitting reasoning chunks. */
  reasoningElapsedMs: number;
  /** Wall-clock when the cancel-frame was observed, or 0 if none. */
  cancelReceivedAt: number;
  /** Userid of whoever sent the cancel frame, or null. */
  cancelReceivedFrom: string | null;
  /** Fact ids injected via the recalled-facts system-prompt block.
   *  Empty when memory was disabled or the recall returned nothing. */
  recalledFactIds: string[];
}

const ZERO_TOKENS: Readonly<TurnTokens> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  steps: 0,
});

/** Tool-call buffer cap. Defends against a pathological loop chewing
 *  unbounded memory across a single turn. Same value used in the
 *  pre-extraction code; preserved for log-shape compatibility. */
const TOOL_CALL_BUFFER_CAP = 50;

function makeTurnId(): string {
  return `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export class TurnState {
  turnId: string | null = null;
  startedAt = 0;
  userId: string | null = null;

  lastChunkAt = 0;
  lastChunkType: string | null = null;
  chunkCount = 0;
  stepCount = 0;
  toolCalls: string[] = [];

  tokens: TurnTokens = { ...ZERO_TOKENS };

  /**
   * Reasoning-time bookkeeping (chat feca41d8). The AI SDK emits
   * `reasoning-start` → 1..N `reasoning-delta` → `reasoning-end` for
   * each block. We measure wall-clock between start and end and
   * accumulate (multi-step turns can interleave reasoning with tool
   * calls). The total is stamped onto the persisted assistant message
   * by the agent in `onChatResponse` so the web UI shows the *measured*
   * "Thought for Ns" label.
   */
  reasoningStartedAt: number | null = null;
  reasoningElapsedMs = 0;

  /**
   * Cancel-frame tracker (chat e05ce53c). Set when we observe a
   * `cf_agent_chat_request_cancel` WS frame. Used by `onChatResponse`
   * / `onChatError` to disambiguate `status: "aborted"` between
   * client-cancel (stop button) and server-internal aborts.
   */
  cancelReceivedAt = 0;
  cancelReceivedFrom: string | null = null;

  /**
   * Per-turn `memory.remember` call counter (task a0e754). The tool
   * checks this against `REMEMBER_CALLS_PER_TURN` and rejects beyond.
   * Stored on the turn (rather than the agent) so it auto-resets
   * with `start()` — no risk of a counter from yesterday's turn
   * silently throttling today's.
   */
  memoryRememberCount = 0;
  /** Ids of facts injected into the system prompt this turn. Stamped
   *  on `turn.complete` audit so an operator can correlate "what did
   *  the model see?" without replaying Vectorize. */
  recalledFactIds: string[] = [];

  /** Begin a new turn. Stamps a fresh `turnId`, resets every counter. */
  start(userId: string | null): void {
    this.turnId = makeTurnId();
    this.startedAt = Date.now();
    this.userId = userId;
    this.lastChunkAt = Date.now();
    this.lastChunkType = null;
    this.chunkCount = 0;
    this.stepCount = 0;
    this.toolCalls = [];
    this.tokens = { ...ZERO_TOKENS };
    // Reasoning + cancel are per-turn. Both reset here so a stale
    // value from a prior turn never bleeds into this one's diagnostics.
    this.reasoningStartedAt = null;
    this.reasoningElapsedMs = 0;
    this.cancelReceivedAt = 0;
    this.cancelReceivedFrom = null;
    this.memoryRememberCount = 0;
    this.recalledFactIds = [];
  }

  /** Bump the `memory.remember` per-turn counter and return the new
   *  value. Tool body compares against the cap and rejects beyond. */
  bumpMemoryRememberCount(): number {
    this.memoryRememberCount += 1;
    return this.memoryRememberCount;
  }

  /** Stamp the recalled fact ids for this turn. Single-shot — caller
   *  is `beforeTurn` after the recall pipeline runs. */
  setRecalledFactIds(ids: string[]): void {
    this.recalledFactIds = ids;
  }

  /**
   * Stamp the heartbeat for an incoming model chunk. Also drives the
   * reasoning-window timer when the chunk type is `reasoning-start` /
   * `reasoning-end`.
   */
  recordChunk(type: string): void {
    const now = Date.now();
    if (type === "reasoning-start") {
      // Defensive: if a previous block didn't close (mid-stream
      // abort), close it implicitly so we don't double-count.
      if (this.reasoningStartedAt != null) {
        this.reasoningElapsedMs += Math.max(0, now - this.reasoningStartedAt);
      }
      this.reasoningStartedAt = now;
    } else if (type === "reasoning-end" && this.reasoningStartedAt != null) {
      this.reasoningElapsedMs += Math.max(0, now - this.reasoningStartedAt);
      this.reasoningStartedAt = null;
    }
    this.lastChunkAt = now;
    this.lastChunkType = type;
    this.chunkCount += 1;
  }

  /**
   * Stamp a cancel-frame receipt. Called by `onMessage` when an
   * incoming WS frame parses as `cf_agent_chat_request_cancel`.
   */
  recordCancel(userId: string | null): void {
    this.cancelReceivedAt = Date.now();
    this.cancelReceivedFrom = userId;
  }

  /**
   * Close any open reasoning window and return the total accumulated
   * wall-clock. Defensive against streams that aborted mid-`reasoning-*`.
   * Called by the pipeline at turn-end; safe to call when no reasoning
   * happened (returns 0).
   */
  finalizeReasoning(): number {
    if (this.reasoningStartedAt != null) {
      this.reasoningElapsedMs += Math.max(0, Date.now() - this.reasoningStartedAt);
      this.reasoningStartedAt = null;
    }
    return this.reasoningElapsedMs;
  }

  /**
   * Accumulate token usage from an AI SDK `onStepFinish` ctx. Missing
   * fields stay at 0 so a provider that returns nothing produces a
   * harmless all-zero row instead of a NaN-poisoned one.
   *
   * `providerMetadata` is the AI SDK's per-step provider escape
   * hatch; for the Anthropic provider it carries
   * `anthropic.cacheCreationInputTokens` and
   * `anthropic.cacheReadInputTokens`. We accumulate both across the
   * steps of a turn so `turn_complete` carries a single roll-up. The
   * shape is loosely typed (`unknown`) because non-Anthropic
   * providers nest different keys here and we don't want to constrain
   * the model factory's choices.
   */
  recordStep(usage: TurnUsageInput | undefined, providerMetadata?: unknown): TurnTokens {
    this.stepCount += 1;
    const t = this.tokens;
    if (usage) {
      t.inputTokens += usage.inputTokens ?? 0;
      t.outputTokens += usage.outputTokens ?? 0;
      t.totalTokens += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      t.reasoningTokens += usage.reasoningTokens ?? 0;
      t.cachedInputTokens += usage.cachedInputTokens ?? 0;
      t.steps += 1;
    }
    const a =
      (providerMetadata as { anthropic?: Record<string, unknown> } | undefined)?.anthropic ?? null;
    if (a) {
      const create = a.cacheCreationInputTokens;
      const read = a.cacheReadInputTokens;
      if (typeof create === "number") t.cacheCreationInputTokens += create;
      if (typeof read === "number") t.cacheReadInputTokens += read;
    }
    return t;
  }

  /** Append a tool-call marker to the bounded buffer. */
  recordToolCall(name: string, success: boolean): void {
    if (this.toolCalls.length < TOOL_CALL_BUFFER_CAP) {
      this.toolCalls.push(`${name}${success ? "" : "!"}`);
    }
  }

  /**
   * End the turn. Resets timing fields so a follow-on turn can't
   * measure against this one. Returns the final snapshot for logging.
   *
   * Heartbeat fields aren't cleared here — they get overwritten in
   * the next `start()`. That's intentional: between turns we still
   * want `_lastChunkAt` to reflect the most recent activity for
   * `chat.ws.close` events.
   */
  end(): TurnSnapshot {
    const snap = this.snapshot();
    this.startedAt = 0;
    return snap;
  }

  /** Frozen point-in-time view of the state — safe to log/audit. */
  snapshot(): TurnSnapshot {
    const now = Date.now();
    return {
      turnId: this.turnId,
      startedAt: this.startedAt,
      userId: this.userId,
      lastChunkAt: this.lastChunkAt,
      lastChunkType: this.lastChunkType,
      chunkCount: this.chunkCount,
      stepCount: this.stepCount,
      toolCalls: [...this.toolCalls],
      tokens: { ...this.tokens },
      durationMs: this.startedAt > 0 ? now - this.startedAt : null,
      msSinceLastChunk: this.lastChunkAt > 0 ? now - this.lastChunkAt : null,
      reasoningElapsedMs: this.reasoningElapsedMs,
      cancelReceivedAt: this.cancelReceivedAt,
      cancelReceivedFrom: this.cancelReceivedFrom,
      recalledFactIds: [...this.recalledFactIds],
    };
  }
}
