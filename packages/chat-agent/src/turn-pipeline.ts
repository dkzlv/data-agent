/**
 * Turn lifecycle orchestrator.
 *
 * Earlier every Think hook in `agent.ts` (`beforeTurn`, `onStepFinish`,
 * `onChunk`, `afterToolCall`, `onChatResponse`, `onChatError`)
 * hand-wired the same shape:
 *
 *   1. mutate `TurnState`
 *   2. emit a structured log event with the bound envelope
 *   3. (sometimes) emit an audit row, wrapped in `waitUntil`
 *
 * Six sites, each with slightly different field sets — easy to drift,
 * hard to verify the wire-shape stays stable across refactors.
 *
 * `TurnPipeline` collapses each lifecycle stage to one method that
 * does (1) → (2) → (3) in a fixed order. Hooks in `agent.ts` become
 * 1-3 line delegations; the pipeline is unit-testable with a mock
 * envelope provider + mock log/audit spies.
 */
import type { ChatResponseResult, ToolCallResultContext } from "@cloudflare/think";
import { hashSql, safePayload } from "@data-agent/shared";
import { describeError } from "./obs-helpers";
import type { TurnState, TurnUsageInput } from "./turn-state";
import type { TurnLogger } from "./turn-logger";

export interface PipelineHost {
  /** Active connection count — folded into turn_complete for abort
   *  attribution (client_disconnect vs server_signal). */
  connectionCount(): number;
  /** AI Gateway id from env, when configured. */
  gatewayId(): string | null;
  /** Best-effort waitUntil so audit writes never block the turn. */
  waitUntil(p: Promise<unknown>): void;
  /** The DO name == chatId, used as the `target` on most audit rows. */
  chatId(): string;
  /** Tenant id from the resolved chat context. Used as a gate for
   *  audit rows (un-resolvable chats skip audit; the LLM call itself
   *  will fail and surface a different error). */
  tenantId(): string | null;
  /**
   * Stamp a measured reasoning duration onto the persisted assistant
   * message. Called by `complete()` when the turn produced reasoning.
   * Best-effort — host swallows + logs failures, never throws.
   */
  stampReasoningElapsed(elapsedMs: number): void;
}

export interface TurnStartFields {
  dbProfileId: string | null;
  modelId: string;
  userId: string | null;
}

export class TurnPipeline {
  constructor(
    private readonly turn: TurnState,
    private readonly log: TurnLogger,
    private readonly host: PipelineHost
  ) {}

  /** Begin a turn — stamp the turn id, emit the start span + audit row. */
  start(fields: TurnStartFields): void {
    this.turn.start(fields.userId);
    this.audit("turn.start", this.host.chatId(), {
      dbProfileId: fields.dbProfileId,
      turnId: this.turn.turnId,
    });
    this.log.event("chat.turn_start", {
      dbProfileId: fields.dbProfileId,
      model: fields.modelId,
    });
  }

  /**
   * Per-step span. The AI SDK fires `onStepFinish` after each model
   * step with a `usage` object whose field names vary by provider;
   * we accept the loose shape and let TurnState fill in zeros.
   *
   * `providerMetadata` is the per-step provider escape hatch — for
   * Anthropic it carries the prompt-cache create/read counts which
   * the turn-state accumulates across the turn (logged as a single
   * roll-up on `chat.turn_complete`).
   */
  step(usage: TurnUsageInput | undefined, providerMetadata?: unknown): void {
    const tokens = this.turn.recordStep(usage, providerMetadata);
    if (!usage) return;
    const snap = this.turn.snapshot();
    this.log.event("chat.turn_step", {
      stepIndex: tokens.steps,
      stepTokensIn: usage.inputTokens ?? 0,
      stepTokensOut: usage.outputTokens ?? 0,
      cumulativeTokensIn: tokens.inputTokens,
      cumulativeTokensOut: tokens.outputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      msSinceTurnStart: snap.durationMs,
      msSinceLastChunk: snap.msSinceLastChunk,
      lastChunkType: snap.lastChunkType,
      chunkCount: snap.chunkCount,
    });
  }

  /**
   * Per-chunk heartbeat. High-frequency: fires per token. We sample
   * the log (1 in 50) so high-volume streams don't spam Workers Logs,
   * but the heartbeat itself updates on every chunk so the next
   * `chat.turn_step` / `chat.turn_complete` event reports an accurate
   * "ms since last chunk".
   */
  chunk(type: string | undefined): void {
    const t = type ?? "unknown";
    this.turn.recordChunk(t);
    if (t !== "text-delta" || this.turn.chunkCount % 50 === 0) {
      const snap = this.turn.snapshot();
      this.log.event("chat.turn_chunk", {
        level: "debug",
        chunkType: t,
        chunkIndex: this.turn.chunkCount,
        msSinceTurnStart: snap.durationMs,
      });
    }
  }

  /**
   * Per-tool-call span + (for security-relevant tools) audit row.
   *
   * Auditable set: `db_query`, `db_introspect`, `artifact.write*`,
   * `chart_save`. Sandbox execution itself isn't a separate audit
   * event — `turn.complete` already records that the turn ran.
   */
  async toolCall(ctx: ToolCallResultContext): Promise<void> {
    const name = ctx.toolName;
    this.turn.recordToolCall(name, ctx.success);

    const snap = this.turn.snapshot();
    this.log.event("chat.tool_call", {
      level: ctx.success ? "info" : "warn",
      tool: name,
      success: ctx.success,
      durationMs: ctx.durationMs,
      msSinceTurnStart: snap.durationMs,
    });

    if (!this.host.tenantId()) return;
    const isAuditable =
      name === "db_query" ||
      name === "db_introspect" ||
      name.startsWith("artifact_write") ||
      name === "chart_save" ||
      // Memory operations (task a0e754). Worth a separate audit row
      // each — write/forget/search are user-affecting in different
      // ways and we want them sliceable in the dashboard. Codemode
      // sanitizes `memory.remember` → `memory_remember` etc., so we
      // match the underscore form here.
      name.startsWith("memory_");
    if (!isAuditable) return;

    const payload = await this.buildToolPayload(name, ctx);
    this.audit(name === "db_query" ? "db.query" : `tool.${name}`, ctx.toolCallId, payload);
  }

  /** Ends the turn cleanly — emit complete span + audit row. */
  complete(result: ChatResponseResult, modelId: string): void {
    // Close any open reasoning window + stamp the total onto the
    // persisted assistant message before the turn ends. The stamp
    // is what lets the web UI render an honest "Thought for Ns"
    // label on replay (chat feca41d8 — the earlier text-length
    // heuristic was a fabrication).
    const reasoningMs = this.turn.finalizeReasoning();
    if (reasoningMs > 0) {
      this.host.stampReasoningElapsed(reasoningMs);
    }

    const snap = this.turn.end();
    const conns = this.host.connectionCount();
    const cancelReceived = snap.cancelReceivedAt > 0;

    // Abort attribution (chat e05ce53c). Three levels of certainty:
    //   - "client_cancel"     — observed `cf_agent_chat_request_cancel`
    //                           frame this turn (stop button or
    //                           programmatic `chat.stop()`).
    //   - "client_disconnect" — aborted with no active WS and no
    //                           cancel frame (tab closed mid-stream).
    //   - "server_signal"     — aborted with WS still open and no
    //                           cancel frame (internal abort path).
    const abortLikelyFrom =
      result.status === "aborted"
        ? cancelReceived
          ? "client_cancel"
          : conns === 0
            ? "client_disconnect"
            : "server_signal"
        : null;
    const cancelReceivedMsBeforeComplete = cancelReceived
      ? Date.now() - snap.cancelReceivedAt
      : null;

    this.log.event("chat.turn_complete", {
      status: result.status,
      durationMs: snap.durationMs,
      model: modelId,
      gatewayId: this.host.gatewayId(),
      tokens: snap.tokens,
      stepCount: snap.stepCount,
      chunkCount: snap.chunkCount,
      lastChunkType: snap.lastChunkType,
      msSinceLastChunk: snap.msSinceLastChunk,
      toolCalls: snap.toolCalls,
      abortLikelyFrom,
      // Direct cancel-frame evidence. `cancelReceivedFrom` is the
      // userId the cancel arrived from (so a future multi-user chat
      // can show "Alice cancelled Bob's turn"). `msBeforeComplete`
      // is how long after the cancel the turn actually wound down.
      cancelReceived,
      cancelReceivedFrom: snap.cancelReceivedFrom,
      cancelReceivedMsBeforeComplete,
    });

    if (!this.host.tenantId()) return;
    this.audit("turn.complete", this.host.chatId(), {
      status: result.status,
      tokens: snap.tokens,
      durationMs: snap.durationMs,
      gateway: { id: this.host.gatewayId(), model: modelId },
      // Audit-DB-only triage parity with the Workers Logs span:
      // an operator can answer "why did that turn abort?" from
      // `inspect-turn.ts` alone, no Workers Logs round-trip.
      abortLikelyFrom,
      cancelReceived,
      // Recall provenance (task a0e754). Empty array when memory was
      // off or the recall produced nothing. Lets an operator answer
      // "what facts did the model see for this turn?" from the audit
      // log alone; the actual fact rows live in `memory_fact` and
      // can be JOINed by id.
      recalledFactIds: snap.recalledFactIds,
      recalledFactCount: snap.recalledFactIds.length,
    });
  }

  /**
   * Ends the turn after a failure. Captures three things beyond the
   * error itself: error class, one level of `cause`, and the streaming
   * fingerprint (last chunk type, ms since last chunk, step count,
   * tool call sequence) — enough to triangulate where the failure hit.
   */
  error(err: unknown, modelId: string): void {
    const snap = this.turn.end();
    const errInfo = describeError(err);
    const cancelReceived = snap.cancelReceivedAt > 0;

    this.log.event("chat.turn_error", {
      level: "error",
      durationMs: snap.durationMs,
      model: modelId,
      stepCount: snap.stepCount,
      chunkCount: snap.chunkCount,
      lastChunkType: snap.lastChunkType,
      msSinceLastChunk: snap.msSinceLastChunk,
      toolCalls: snap.toolCalls,
      errorName: errInfo.name,
      errorMessage: errInfo.message,
      errorCause: errInfo.cause,
      isAbort: errInfo.isAbort,
      // Cancel-frame evidence on the error path too: `cancelReceived
      // === true` + `isAbort === true` is the unambiguous client-cancel
      // signature even when AI SDK escalated the abort to an error.
      cancelReceived,
      cancelReceivedFrom: snap.cancelReceivedFrom,
    });

    this.audit("turn.error", this.host.chatId(), {
      error: errInfo.message.slice(0, 500),
      errorName: errInfo.name,
      errorCause: errInfo.cause,
      isAbort: errInfo.isAbort,
      turnId: snap.turnId,
      stepCount: snap.stepCount,
      chunkCount: snap.chunkCount,
      lastChunkType: snap.lastChunkType,
      msSinceLastChunk: snap.msSinceLastChunk,
      durationMs: snap.durationMs,
      cancelReceived,
    });
  }

  /**
   * Single helper that collapses the "build audit row + waitUntil"
   * pattern. Returns nothing — the pipeline owns the waitUntil.
   */
  private audit(
    action: string,
    target: string | null,
    payload: Record<string, unknown> | null
  ): void {
    const promise = this.log.audit(action, target, payload);
    if (promise) this.host.waitUntil(promise);
  }

  /**
   * Build the audit payload for a tool call. `db_query` gets a SQL
   * hash + row/byte stats (no raw SQL, no rows); everything else gets
   * a size-capped input dump.
   */
  private async buildToolPayload(
    name: string,
    ctx: ToolCallResultContext
  ): Promise<Record<string, unknown>> {
    try {
      if (name === "db_query") {
        const input = ctx.input as { sql?: string; params?: unknown[] };
        const output = ctx.output as { rows?: unknown[]; truncated?: boolean } | undefined;
        return {
          sqlHash: input?.sql ? await hashSql(input.sql) : null,
          paramsCount: Array.isArray(input?.params) ? input!.params!.length : 0,
          rowCount: Array.isArray(output?.rows) ? output!.rows!.length : null,
          truncated: output?.truncated ?? null,
          success: ctx.success,
          durationMs: ctx.durationMs,
        };
      }
      return {
        success: ctx.success,
        durationMs: ctx.durationMs,
        input: safePayload(ctx.input as Record<string, unknown>, 800),
      };
    } catch {
      return { success: ctx.success };
    }
  }
}
