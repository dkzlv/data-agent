import { describe, expect, it } from "vitest";
import {
  hashContent,
  isMemoryKind,
  MEMORY_CONTENT_MAX,
  MEMORY_CONTENT_MIN,
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  normalizeContent,
  validateMemoryContent,
} from "./memory";

describe("normalizeContent", () => {
  it("trims and collapses whitespace", () => {
    const r = normalizeContent("  Total   cents not\ndollars  ");
    expect(r.display).toBe("Total cents not dollars");
    expect(r.normalized).toBe("total cents not dollars");
  });
  it("preserves punctuation (it carries meaning)", () => {
    const r = normalizeContent("MRR != ARR");
    expect(r.display).toBe("MRR != ARR");
  });
});

describe("hashContent", () => {
  it("produces 64-char hex sha256", async () => {
    const h = await hashContent("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable", async () => {
    const a = await hashContent("foo bar");
    const b = await hashContent("foo bar");
    expect(a).toBe(b);
  });
  it("differs across inputs", async () => {
    const a = await hashContent("foo");
    const b = await hashContent("bar");
    expect(a).not.toBe(b);
  });
});

describe("validateMemoryContent", () => {
  it("rejects non-strings", () => {
    expect(validateMemoryContent(42)).toEqual({ ok: false, reason: expect.any(String) });
  });
  it("rejects too-short content", () => {
    const r = validateMemoryContent("hi");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too short/);
  });
  it("rejects too-long content", () => {
    const r = validateMemoryContent("x".repeat(MEMORY_CONTENT_MAX + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/);
  });
  it("accepts at the boundary lengths", () => {
    const min = validateMemoryContent("x".repeat(MEMORY_CONTENT_MIN));
    const max = validateMemoryContent("x".repeat(MEMORY_CONTENT_MAX));
    expect(min.ok).toBe(true);
    expect(max.ok).toBe(true);
  });
  it("accepts at MAX-1 and rejects at MAX+1 (post-bump to 2000 — task 996861)", () => {
    // The bump from 500 → 2000 was driven by chat 5f2690a6: schema-
    // shaped facts inherently want more room. Locking the boundary
    // here so an accidental revert (or another bump) is loud.
    expect(MEMORY_CONTENT_MAX).toBe(2000);
    const justUnder = validateMemoryContent("x".repeat(1999));
    const justOver = validateMemoryContent("x".repeat(2001));
    expect(justUnder.ok).toBe(true);
    expect(justOver.ok).toBe(false);
    if (!justOver.ok) expect(justOver.reason).toMatch(/too long/);
  });
  it("returns normalized + display alongside ok", () => {
    const r = validateMemoryContent("  Some  Fact   here  ");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.display).toBe("Some Fact here");
      expect(r.normalized).toBe("some fact here");
    }
  });
});

describe("MEMORY_KINDS", () => {
  it("isMemoryKind narrows correctly", () => {
    expect(isMemoryKind("schema_semantic")).toBe(true);
    expect(isMemoryKind("schema_x")).toBe(false);
    expect(isMemoryKind(42)).toBe(false);
  });
  it("has a label for every kind (catches accidental drift)", () => {
    for (const k of MEMORY_KINDS) {
      expect(MEMORY_KIND_LABELS[k]).toBeTypeOf("string");
    }
  });
});

describe("embedding constants", () => {
  it("model id pin matches dimensions (changing one without the other will silently break Vectorize)", () => {
    // bge-base-en-v1.5 is 768-d. If we ever swap the model we MUST
    // recreate the Vectorize index with new dims and re-embed every
    // existing fact. The pin here makes the change visible in code
    // review.
    expect(MEMORY_EMBED_MODEL).toBe("@cf/baai/bge-base-en-v1.5");
    expect(MEMORY_EMBED_DIMENSIONS).toBe(768);
  });
});
