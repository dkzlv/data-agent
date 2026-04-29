/**
 * Top-K memory recall for the turn-time read path (task a0e754).
 *
 * Pipeline:
 *
 *   query text  →  embedTextOrNull  →  queryVectors  →  hydrateFacts
 *               →  rerank (curation + diversity)
 *               →  truncate to N facts / ~M tokens
 *               →  return list (in order; first is most relevant)
 *
 * Failure semantics: every step logs and returns an empty list on
 * error. Memory is decorative; the turn proceeds regardless.
 *
 * Reranking is a small ceremony, not magic:
 *   - High `hitCount` gets a multiplicative boost. Stable facts that
 *     get recalled a lot float to the top.
 *   - Per-kind diversity cap (≤ 4 of any single kind in the final
 *     list) prevents a model that loves saving "query_pattern_good"
 *     from drowning out "schema_semantic" + "business_def".
 *   - Token budget cap (~1500 tokens of content) is the final
 *     truncator — we'd rather drop the 9th-most-relevant fact than
 *     blow the prompt budget.
 */
import { logEvent } from "@data-agent/shared";
import type { MemoryFact } from "@data-agent/db/schema";
import type { Env } from "../env";
import { embedTextOrNull } from "./embed";
import { hydrateFacts } from "./store";
import { queryVectors, type QueryHit } from "./vectorize";

export interface RetrieveInputs {
  env: Env;
  tenantId: string;
  dbProfileId: string;
  /** Free-form text to embed. Usually `latestUserMsg + chatTitle`. */
  query: string;
  /** Initial topK pulled from Vectorize. Larger than the final cap
   *  so the rerank step has room to swap things around. */
  topK?: number;
  /** Final cap on returned facts. */
  maxFacts?: number;
  /** Token budget for the recalled-facts block. ~3-4 chars/token
   *  for English; we use 4 chars/token as a conservative estimate. */
  maxTokens?: number;
}

export interface RetrieveResult {
  facts: MemoryFact[];
  /** Ordered scores parallel to `facts`. Stamped onto recall WS
   *  frame for client-side rendering ("3 facts at avg 0.81"). */
  scores: number[];
  /** Diagnostic — number of vector hits before rerank/truncation. */
  rawHits: number;
  /** True when the recall ran but produced zero usable facts.
   *  Distinct from "skipped because no dbProfile" — that path
   *  never calls retrieve. */
  empty: boolean;
}

/** Defaults sized so the rerank has headroom but no individual call
 *  is unboundedly expensive. */
const DEFAULT_TOPK = 12;
const DEFAULT_MAX_FACTS = 8;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_PER_KIND_CAP = 4;

/**
 * Multiplier on `score` based on `hitCount`. Capped so a "popular"
 * fact can't override a much more relevant one. Concretely:
 *   - hitCount 0  → 1.00x
 *   - hitCount 5  → 1.05x
 *   - hitCount 25 → 1.10x
 *   - hitCount ∞  → 1.10x (clamp)
 *
 * Curve shape: `1 + min(0.10, hitCount / 250)`. Linear, easy to
 * reason about. Mostly cosmetic at low counts; the diversity cap
 * does the real work.
 */
function curationBoost(hitCount: number): number {
  return 1 + Math.min(0.1, Math.max(0, hitCount) / 250);
}

/**
 * 4 chars/token is a conservative English estimate. Real tokenizers
 * vary (Anthropic ~3.5, GPT-2 ~3.7) — we want to under-shoot the
 * budget so we don't blow it.
 */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Run the recall pipeline. Returns an empty result on any failure.
 */
export async function retrieveMemory(inputs: RetrieveInputs): Promise<RetrieveResult> {
  const topK = inputs.topK ?? DEFAULT_TOPK;
  const maxFacts = inputs.maxFacts ?? DEFAULT_MAX_FACTS;
  const maxTokens = inputs.maxTokens ?? DEFAULT_MAX_TOKENS;

  const trimmed = inputs.query.trim();
  if (!trimmed) {
    return { facts: [], scores: [], rawHits: 0, empty: true };
  }

  const vector = await embedTextOrNull(inputs.env, trimmed);
  if (!vector) {
    return { facts: [], scores: [], rawHits: 0, empty: true };
  }

  const hits = await queryVectors(inputs.env, {
    vector,
    tenantId: inputs.tenantId,
    dbProfileId: inputs.dbProfileId,
    topK,
  });
  if (hits.length === 0) {
    logEvent({
      event: "memory.recall",
      level: "debug",
      tenantId: inputs.tenantId,
      dbProfileId: inputs.dbProfileId,
      hits: 0,
    });
    return { facts: [], scores: [], rawHits: 0, empty: true };
  }

  const rows = await hydrateFacts(inputs.env, {
    tenantId: inputs.tenantId,
    dbProfileId: inputs.dbProfileId,
    ids: hits.map((h) => h.id),
  });

  if (rows.length === 0) {
    // Vectorize had hits but Postgres filtered them all (soft-deleted,
    // or wrong tenant — defense-in-depth). Worth a debug heartbeat:
    // a chronic mismatch hints we're not running the Vectorize
    // delete sweep often enough.
    logEvent({
      event: "memory.recall",
      level: "debug",
      tenantId: inputs.tenantId,
      dbProfileId: inputs.dbProfileId,
      hits: hits.length,
      hydrated: 0,
      // ^ note: hydrated < hits is the actionable signal
    });
    return { facts: [], scores: [], rawHits: hits.length, empty: true };
  }

  const ranked = rerank(rows, hits, { perKindCap: DEFAULT_PER_KIND_CAP });
  const truncated = truncateByTokens(ranked, maxFacts, maxTokens);

  logEvent({
    event: "memory.recall",
    level: "info",
    tenantId: inputs.tenantId,
    dbProfileId: inputs.dbProfileId,
    hits: hits.length,
    hydrated: rows.length,
    returned: truncated.facts.length,
    topScore: truncated.scores[0] ?? null,
  });

  return {
    facts: truncated.facts,
    scores: truncated.scores,
    rawHits: hits.length,
    empty: truncated.facts.length === 0,
  };
}

/**
 * Score-boost + diversity-aware sort. Pure function — exported for
 * unit tests so we can verify rerank against fixtures.
 */
export function rerank(
  rows: MemoryFact[],
  hits: QueryHit[],
  opts: { perKindCap: number }
): { facts: MemoryFact[]; scores: number[] } {
  const scoreById = new Map(hits.map((h) => [h.id, h.score]));
  // Score each row using vector score * curation boost.
  const scored = rows
    .map((row) => ({
      row,
      score: (scoreById.get(row.id) ?? 0) * curationBoost(row.hitCount),
    }))
    // Highest first.
    .sort((a, b) => b.score - a.score);

  // Diversity pass: walk highest-first and skip rows whose kind has
  // already been seen `perKindCap` times. This DOESN'T reorder
  // within-kind — it just drops surplus.
  const perKind = new Map<string, number>();
  const kept: typeof scored = [];
  for (const s of scored) {
    const seen = perKind.get(s.row.kind) ?? 0;
    if (seen >= opts.perKindCap) continue;
    perKind.set(s.row.kind, seen + 1);
    kept.push(s);
  }

  return {
    facts: kept.map((k) => k.row),
    scores: kept.map((k) => k.score),
  };
}

/**
 * Truncate by both fact-count and token-budget, whichever bites
 * first. Pure function — exported for unit tests.
 */
export function truncateByTokens(
  ranked: { facts: MemoryFact[]; scores: number[] },
  maxFacts: number,
  maxTokens: number
): { facts: MemoryFact[]; scores: number[] } {
  const out: MemoryFact[] = [];
  const outScores: number[] = [];
  let tokens = 0;
  for (let i = 0; i < ranked.facts.length; i++) {
    if (out.length >= maxFacts) break;
    const fact = ranked.facts[i]!;
    const factTokens = approxTokens(fact.content);
    if (tokens + factTokens > maxTokens && out.length > 0) break;
    tokens += factTokens;
    out.push(fact);
    outScores.push(ranked.scores[i] ?? 0);
  }
  return { facts: out, scores: outScores };
}
