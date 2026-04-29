import { describe, expect, it, vi, beforeEach } from "vitest";
import { TurnPipeline, type PipelineHost } from "./turn-pipeline";
import { TurnState } from "./turn-state";
import { TurnLogger, type EnvelopeProvider } from "./turn-logger";

const logEventSpy = vi.fn();
const auditSpy = vi.fn();

vi.mock("@data-agent/shared", async () => {
  const actual = await vi.importActual<typeof import("@data-agent/shared")>("@data-agent/shared");
  return {
    ...actual,
    logEvent: (...args: unknown[]) => logEventSpy(...args),
  };
});

vi.mock("./audit", () => ({
  auditFromAgent: (...args: unknown[]) => auditSpy(...args),
}));

class StubProvider implements EnvelopeProvider {
  chatId = "chat_a";
  tenantId: string | null = "tenant_b";
  userId: string | null = "user_c";
  turnId: string | null = null;
}

function makePipeline() {
  const turn = new TurnState();
  const provider = new StubProvider();
  // Wire the turnId envelope to follow the live TurnState.
  Object.defineProperty(provider, "turnId", { get: () => turn.turnId });

  const log = new TurnLogger({} as never, provider);
  const waitUntilCalls: Promise<unknown>[] = [];
  const stampedReasoning: number[] = [];
  const host: PipelineHost = {
    connectionCount: () => 1,
    gatewayId: () => "gw_x",
    waitUntil: (p) => {
      waitUntilCalls.push(p);
    },
    chatId: () => "chat_a",
    tenantId: () => "tenant_b",
    stampReasoningElapsed: (ms) => stampedReasoning.push(ms),
  };
  return {
    pipeline: new TurnPipeline(turn, log, host),
    turn,
    provider,
    waitUntilCalls,
    stampedReasoning,
    host,
  };
}

beforeEach(() => {
  logEventSpy.mockReset();
  auditSpy.mockReset();
  auditSpy.mockResolvedValue(undefined);
});

describe("TurnPipeline.start", () => {
  it("starts the turn, audits, and emits a turn_start span", () => {
    const { pipeline, turn, waitUntilCalls } = makePipeline();
    pipeline.start({ dbProfileId: "p1", modelId: "m1", userId: "u_drv" });
    expect(turn.turnId).toBeTruthy();
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[1]).toMatchObject({
      action: "turn.start",
      payload: { dbProfileId: "p1", turnId: turn.turnId },
    });
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.turn_start", model: "m1", dbProfileId: "p1" })
    );
    expect(waitUntilCalls).toHaveLength(1);
  });
});

describe("TurnPipeline.step / chunk", () => {
  it("step accumulates token usage and emits a step span", () => {
    const { pipeline, turn } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    pipeline.step({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(turn.tokens.inputTokens).toBe(10);
    expect(logEventSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "chat.turn_step",
        cumulativeTokensIn: 10,
        cumulativeTokensOut: 20,
      })
    );
  });

  it("chunk is sampled (every 50th text-delta logs)", () => {
    const { pipeline, turn } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    logEventSpy.mockClear();
    for (let i = 0; i < 49; i++) pipeline.chunk("text-delta");
    // Index 50 (chunkCount % 50 === 0 after 50th call) should log.
    pipeline.chunk("text-delta");
    expect(turn.chunkCount).toBe(50);
    // Of the 50 calls, only the 50th logs.
    expect(logEventSpy).toHaveBeenCalledTimes(1);

    pipeline.chunk("tool-call"); // non-text-delta always logs
    expect(logEventSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TurnPipeline.toolCall", () => {
  it("logs every tool call as chat.tool_call", async () => {
    const { pipeline } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    logEventSpy.mockClear();
    auditSpy.mockClear();

    await pipeline.toolCall({
      toolName: "some_unaudited_tool",
      success: true,
      durationMs: 12,
      input: {},
      output: {},
      toolCallId: "call_1",
    } as never);
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.tool_call", tool: "some_unaudited_tool" })
    );
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("audits db_query with sqlHash + row stats", async () => {
    const { pipeline } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    auditSpy.mockClear();

    await pipeline.toolCall({
      toolName: "db_query",
      success: true,
      durationMs: 100,
      input: { sql: "SELECT 1", params: [1, 2] },
      output: { rows: [{ a: 1 }], truncated: false },
      toolCallId: "call_q",
    } as never);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const call = auditSpy.mock.calls[0]?.[1] as {
      action: string;
      payload: Record<string, unknown>;
    };
    expect(call.action).toBe("db.query");
    expect(call.payload.paramsCount).toBe(2);
    expect(call.payload.rowCount).toBe(1);
    expect(typeof call.payload.sqlHash).toBe("string");
  });

  it("audits chart_save with generic payload", async () => {
    const { pipeline } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    auditSpy.mockClear();

    await pipeline.toolCall({
      toolName: "chart_save",
      success: true,
      durationMs: 50,
      input: { name: "x.png" },
      output: {},
      toolCallId: "call_c",
    } as never);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]?.[1]).toMatchObject({
      action: "tool.chart_save",
    });
  });
});

describe("TurnPipeline.complete / error", () => {
  it("complete emits a turn_complete span + audit", () => {
    const { pipeline, waitUntilCalls } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    auditSpy.mockClear();
    logEventSpy.mockClear();
    waitUntilCalls.length = 0;

    pipeline.complete({ status: "ok" } as never, "m1");
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "chat.turn_complete", status: "ok" })
    );
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(waitUntilCalls).toHaveLength(1);
  });

  it("complete with status=aborted + zero connections → client_disconnect", () => {
    const { pipeline, host } = makePipeline();
    (host as { connectionCount: () => number }).connectionCount = () => 0;
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    logEventSpy.mockClear();
    pipeline.complete({ status: "aborted" } as never, "m1");
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ abortLikelyFrom: "client_disconnect" })
    );
  });

  it("complete with cancel frame → client_cancel + cancelReceived true", () => {
    const { pipeline, turn } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    turn.recordCancel("alice");
    logEventSpy.mockClear();
    pipeline.complete({ status: "aborted" } as never, "m1");
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        abortLikelyFrom: "client_cancel",
        cancelReceived: true,
        cancelReceivedFrom: "alice",
      })
    );
  });

  it("complete stamps measured reasoning duration", () => {
    const { pipeline, turn, stampedReasoning } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    turn.recordChunk("reasoning-start");
    // recordChunk reads Date.now(); we trust its accumulator.
    // Force a non-zero elapsed via direct field nudge for the test.
    turn.reasoningElapsedMs = 1234;
    pipeline.complete({ status: "ok" } as never, "m1");
    expect(stampedReasoning).toEqual([1234]);
  });

  it("complete skips reasoning stamp when no reasoning happened", () => {
    const { pipeline, stampedReasoning } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    pipeline.complete({ status: "ok" } as never, "m1");
    expect(stampedReasoning).toEqual([]);
  });

  it("error emits a turn_error span + audit", () => {
    const { pipeline } = makePipeline();
    pipeline.start({ dbProfileId: null, modelId: "m", userId: null });
    auditSpy.mockClear();
    logEventSpy.mockClear();

    pipeline.error(new Error("kaboom"), "m1");
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.turn_error",
        errorMessage: "kaboom",
      })
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "turn.error" })
    );
  });
});
