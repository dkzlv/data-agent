import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TurnState } from "./turn-state";

describe("TurnState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start()", () => {
    it("stamps a fresh turn id and zeroes counters", () => {
      const t = new TurnState();
      t.start("user_a");
      expect(t.turnId).toMatch(/^t_/);
      expect(t.startedAt).toBeGreaterThan(0);
      expect(t.userId).toBe("user_a");
      expect(t.chunkCount).toBe(0);
      expect(t.stepCount).toBe(0);
      expect(t.toolCalls).toEqual([]);
      expect(t.tokens.inputTokens).toBe(0);
      expect(t.tokens.outputTokens).toBe(0);
    });

    it("clears carry-over from a previous turn", () => {
      const t = new TurnState();
      t.start("user_a");
      t.recordChunk("text-delta");
      t.recordStep({ inputTokens: 100, outputTokens: 50 });
      t.recordToolCall("db_query", true);

      t.start("user_b");
      expect(t.chunkCount).toBe(0);
      expect(t.stepCount).toBe(0);
      expect(t.toolCalls).toEqual([]);
      expect(t.tokens.inputTokens).toBe(0);
      expect(t.tokens.outputTokens).toBe(0);
      expect(t.userId).toBe("user_b");
    });

    it("generates unique turn ids", () => {
      const t = new TurnState();
      t.start(null);
      const a = t.turnId;
      vi.advanceTimersByTime(1);
      t.start(null);
      const b = t.turnId;
      expect(a).not.toBe(b);
    });
  });

  describe("recordChunk()", () => {
    it("updates heartbeat fields", () => {
      const t = new TurnState();
      t.start("u");
      vi.advanceTimersByTime(50);
      t.recordChunk("text-delta");
      expect(t.lastChunkType).toBe("text-delta");
      expect(t.chunkCount).toBe(1);
      expect(t.lastChunkAt).toBe(Date.now());
    });

    it("counts every chunk regardless of type", () => {
      const t = new TurnState();
      t.start("u");
      t.recordChunk("text-delta");
      t.recordChunk("text-delta");
      t.recordChunk("tool-input-start");
      expect(t.chunkCount).toBe(3);
    });
  });

  describe("recordStep()", () => {
    it("accumulates token usage across steps", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      t.recordStep({ inputTokens: 200, outputTokens: 80, totalTokens: 280 });
      expect(t.tokens.inputTokens).toBe(300);
      expect(t.tokens.outputTokens).toBe(130);
      expect(t.tokens.totalTokens).toBe(430);
      expect(t.tokens.steps).toBe(2);
    });

    it("infers totalTokens when missing", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep({ inputTokens: 10, outputTokens: 5 });
      expect(t.tokens.totalTokens).toBe(15);
    });

    it("treats missing fields as 0 (no NaN poisoning)", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep({ inputTokens: 10 });
      t.recordStep({});
      expect(t.tokens.inputTokens).toBe(10);
      expect(t.tokens.outputTokens).toBe(0);
      expect(t.tokens.totalTokens).toBe(10);
    });

    it("still increments stepCount when usage is undefined", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep(undefined);
      expect(t.stepCount).toBe(1);
      // tokens.steps only increments when usage is truthy
      expect(t.tokens.steps).toBe(0);
    });

    it("accumulates reasoning + cached input tokens", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep({ reasoningTokens: 200, cachedInputTokens: 50 });
      t.recordStep({ reasoningTokens: 100 });
      expect(t.tokens.reasoningTokens).toBe(300);
      expect(t.tokens.cachedInputTokens).toBe(50);
    });

    it("accumulates Anthropic prompt-cache create/read tokens from providerMetadata", () => {
      // Task 722e12: turn-complete logs cache create/read totals so
      // we can confirm caching from `inspect-turn` alone (no AI
      // Gateway round-trip). The provider nests the counts under
      // `providerMetadata.anthropic.{cacheCreationInputTokens,
      // cacheReadInputTokens}`.
      const t = new TurnState();
      t.start("u");
      t.recordStep(
        { inputTokens: 200, outputTokens: 50 },
        { anthropic: { cacheCreationInputTokens: 1500, cacheReadInputTokens: 0 } }
      );
      t.recordStep(
        { inputTokens: 50, outputTokens: 30 },
        { anthropic: { cacheCreationInputTokens: 0, cacheReadInputTokens: 1500 } }
      );
      expect(t.tokens.cacheCreationInputTokens).toBe(1500);
      expect(t.tokens.cacheReadInputTokens).toBe(1500);
    });

    it("ignores non-numeric or missing providerMetadata cache fields", () => {
      const t = new TurnState();
      t.start("u");
      t.recordStep({ inputTokens: 10 }); // no metadata
      t.recordStep({ inputTokens: 10 }, undefined);
      t.recordStep({ inputTokens: 10 }, { anthropic: {} });
      t.recordStep({ inputTokens: 10 }, { openai: { whatever: 1 } });
      expect(t.tokens.cacheCreationInputTokens).toBe(0);
      expect(t.tokens.cacheReadInputTokens).toBe(0);
    });
  });

  describe("recordToolCall()", () => {
    it("appends with success marker", () => {
      const t = new TurnState();
      t.start("u");
      t.recordToolCall("db_query", true);
      t.recordToolCall("db_query", false);
      t.recordToolCall("artifact_write", true);
      expect(t.toolCalls).toEqual(["db_query", "db_query!", "artifact_write"]);
    });

    it("caps the buffer at 50 entries", () => {
      const t = new TurnState();
      t.start("u");
      for (let i = 0; i < 100; i++) t.recordToolCall("x", true);
      expect(t.toolCalls.length).toBe(50);
    });
  });

  describe("snapshot()", () => {
    it("returns durationMs + msSinceLastChunk", () => {
      const t = new TurnState();
      t.start("u");
      vi.advanceTimersByTime(100);
      t.recordChunk("text-delta");
      vi.advanceTimersByTime(50);
      const snap = t.snapshot();
      expect(snap.durationMs).toBe(150);
      expect(snap.msSinceLastChunk).toBe(50);
    });

    it("returns null for durations when turn isn't active", () => {
      const t = new TurnState();
      const snap = t.snapshot();
      expect(snap.durationMs).toBeNull();
      expect(snap.msSinceLastChunk).toBeNull();
    });

    it("returns a defensive copy of toolCalls + tokens", () => {
      const t = new TurnState();
      t.start("u");
      t.recordToolCall("db_query", true);
      const snap = t.snapshot();
      // Mutating the snapshot must not bleed back into live state.
      snap.toolCalls.push("oops");
      snap.tokens.inputTokens = 999;
      expect(t.toolCalls).toEqual(["db_query"]);
      expect(t.tokens.inputTokens).toBe(0);
    });
  });

  describe("end()", () => {
    it("returns a final snapshot and resets startedAt", () => {
      const t = new TurnState();
      t.start("u");
      vi.advanceTimersByTime(200);
      const snap = t.end();
      expect(snap.durationMs).toBe(200);
      expect(t.startedAt).toBe(0);
    });

    it("subsequent snapshot reports null durationMs after end()", () => {
      const t = new TurnState();
      t.start("u");
      t.end();
      const snap = t.snapshot();
      expect(snap.durationMs).toBeNull();
    });
  });

  describe("reasoning timer", () => {
    it("accumulates wall-clock between reasoning-start and reasoning-end", () => {
      const t = new TurnState();
      t.start("u");
      t.recordChunk("reasoning-start");
      vi.advanceTimersByTime(800);
      t.recordChunk("reasoning-delta");
      vi.advanceTimersByTime(200);
      t.recordChunk("reasoning-end");
      expect(t.reasoningElapsedMs).toBe(1000);
    });

    it("handles multiple reasoning blocks across a turn", () => {
      const t = new TurnState();
      t.start("u");
      t.recordChunk("reasoning-start");
      vi.advanceTimersByTime(500);
      t.recordChunk("reasoning-end");
      t.recordChunk("text-delta");
      t.recordChunk("reasoning-start");
      vi.advanceTimersByTime(300);
      t.recordChunk("reasoning-end");
      expect(t.reasoningElapsedMs).toBe(800);
    });

    it("finalizeReasoning closes a hanging window (mid-stream abort)", () => {
      const t = new TurnState();
      t.start("u");
      t.recordChunk("reasoning-start");
      vi.advanceTimersByTime(700);
      // No reasoning-end — stream aborted.
      expect(t.finalizeReasoning()).toBe(700);
      // Idempotent: second call returns same total without re-adding.
      expect(t.finalizeReasoning()).toBe(700);
    });

    it("resets reasoning state on next start()", () => {
      const t = new TurnState();
      t.start("u");
      t.recordChunk("reasoning-start");
      vi.advanceTimersByTime(500);
      t.recordChunk("reasoning-end");
      t.start("u");
      expect(t.reasoningElapsedMs).toBe(0);
      expect(t.reasoningStartedAt).toBeNull();
    });
  });

  describe("cancel-frame", () => {
    it("recordCancel stamps timestamp + sender", () => {
      const t = new TurnState();
      t.start("u");
      vi.advanceTimersByTime(2000);
      t.recordCancel("alice");
      expect(t.cancelReceivedAt).toBeGreaterThan(0);
      expect(t.cancelReceivedFrom).toBe("alice");
    });

    it("resets on next start()", () => {
      const t = new TurnState();
      t.start("u");
      t.recordCancel("alice");
      t.start("u");
      expect(t.cancelReceivedAt).toBe(0);
      expect(t.cancelReceivedFrom).toBeNull();
    });
  });
});
