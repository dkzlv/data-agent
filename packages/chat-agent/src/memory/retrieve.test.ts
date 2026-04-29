import { describe, expect, it } from "vitest";
import type { MemoryFact } from "@data-agent/db/schema";
import { rerank, truncateByTokens } from "./retrieve";

/** Fixture builder so tests stay declarative. */
function fact(over: Partial<MemoryFact> & Pick<MemoryFact, "id" | "kind">): MemoryFact {
  const now = new Date();
  return {
    tenantId: "t1",
    dbProfileId: "p1",
    content: "default content",
    payload: null,
    sourceChatId: null,
    sourceTurnId: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    contentHash: "h",
    hitCount: 0,
    lastUsedAt: null,
    deletedAt: null,
    ...over,
  } as MemoryFact;
}

describe("rerank", () => {
  it("orders by score (highest first) before any diversity pass", () => {
    const rows = [
      fact({ id: "a", kind: "schema_semantic" }),
      fact({ id: "b", kind: "schema_semantic" }),
      fact({ id: "c", kind: "schema_semantic" }),
    ];
    const hits = [
      { id: "a", score: 0.5 },
      { id: "b", score: 0.9 },
      { id: "c", score: 0.7 },
    ];
    const out = rerank(rows, hits, { perKindCap: 99 });
    expect(out.facts.map((f) => f.id)).toEqual(["b", "c", "a"]);
  });

  it("applies curation boost from hitCount", () => {
    const rows = [
      fact({ id: "a", kind: "schema_semantic", hitCount: 0 }),
      fact({ id: "b", kind: "schema_semantic", hitCount: 250 }), // gets max +10% boost
    ];
    // a has higher base score, but b's boost should overtake.
    const hits = [
      { id: "a", score: 0.85 },
      { id: "b", score: 0.8 }, // 0.8 * 1.10 = 0.88 > 0.85
    ];
    const out = rerank(rows, hits, { perKindCap: 99 });
    expect(out.facts[0]!.id).toBe("b");
  });

  it("enforces per-kind diversity cap", () => {
    const rows = [
      fact({ id: "a", kind: "query_pattern_good" }),
      fact({ id: "b", kind: "query_pattern_good" }),
      fact({ id: "c", kind: "query_pattern_good" }),
      fact({ id: "d", kind: "query_pattern_good" }),
      fact({ id: "e", kind: "query_pattern_good" }),
      fact({ id: "f", kind: "schema_semantic" }),
    ];
    // All same score so order is preserved; diversity cap drops the
    // 5th query_pattern_good even though it would otherwise be kept.
    const hits = rows.map((r) => ({ id: r.id, score: 0.5 }));
    const out = rerank(rows, hits, { perKindCap: 4 });
    expect(out.facts.map((f) => f.id)).toEqual(["a", "b", "c", "d", "f"]);
  });
});

describe("truncateByTokens", () => {
  it("respects maxFacts", () => {
    const facts = Array.from({ length: 20 }, (_, i) =>
      fact({ id: String(i), kind: "schema_semantic", content: "x" })
    );
    const scores = facts.map(() => 1);
    const out = truncateByTokens({ facts, scores }, 5, 10_000);
    expect(out.facts.length).toBe(5);
  });

  it("respects token budget", () => {
    // 4 chars/token; each content of 400 chars → ~100 tokens.
    const facts = Array.from({ length: 20 }, (_, i) =>
      fact({ id: String(i), kind: "schema_semantic", content: "x".repeat(400) })
    );
    const scores = facts.map(() => 1);
    // 250-token budget → 2 facts (200 tokens) before next 100-token
    // fact would push us over.
    const out = truncateByTokens({ facts, scores }, 99, 250);
    expect(out.facts.length).toBe(2);
  });

  it("always keeps the first fact even if it alone overflows the budget", () => {
    // Otherwise empty-recall on long single fact would silently
    // produce an empty list; better to truncate the prompt slightly.
    const facts = [fact({ id: "huge", kind: "schema_semantic", content: "x".repeat(40_000) })];
    const out = truncateByTokens({ facts, scores: [1] }, 99, 100);
    expect(out.facts.length).toBe(1);
  });
});
