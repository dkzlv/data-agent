/**
 * Workers AI embedding helper for memory facts (task a0e754).
 *
 * Single responsibility: take text, return a 768-d float array.
 * Wrapped in its own module so:
 *   - the model id + dim assertion live in one place
 *   - we can mock it cleanly in unit tests (retrieve.test.ts)
 *   - a future swap to a different embedding model touches one file
 *
 * The Workers AI binding handles retries / rate limits internally;
 * we don't add a second layer. Embedding is on the recall hot-path
 * (every turn that has a dbProfile), so a per-call overhead matters
 * — but we intentionally don't cache embeddings between turns: the
 * recall query is built per-turn from the latest user message, so
 * cache hits would be vanishingly rare.
 */
import {
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  truncateMessage,
  logEvent,
} from "@data-agent/shared";
import type { Env } from "../env";

/**
 * Hard cap on input chars. bge-base-en-v1.5 has a 512-token context;
 * 1500 chars covers virtually any reasonable user message and stays
 * well below the model's truncation point. Beyond that we'd be
 * embedding noise.
 */
const MAX_EMBED_INPUT_CHARS = 1500;

/**
 * Embed a single text into a 768-d cosine-friendly vector.
 *
 * Throws on hard failure (binding error, dim mismatch). Callers in
 * the hot path catch and degrade gracefully — see
 * `retrieve.ts`'s "memory is decorative; never blocks a turn".
 *
 * Why we throw rather than return null:
 *   - Decorative-only paths (recall) wrap in try/catch already.
 *   - Critical paths (write) need to know an embed failed so they
 *     can roll back the Postgres row. Silent failure = drift between
 *     Postgres and Vectorize, which is hard to diagnose later.
 */
export async function embedText(env: Env, raw: string): Promise<number[]> {
  const text = raw.length > MAX_EMBED_INPUT_CHARS ? raw.slice(0, MAX_EMBED_INPUT_CHARS) : raw;
  const startedAt = Date.now();

  // Workers AI binding `.run()` shape: returns `{ data: number[][] }`
  // for embedding models, even with a single input. The first row is
  // ours.
  const result = (await env.AI.run(MEMORY_EMBED_MODEL, { text: [text] })) as {
    data?: number[][];
    shape?: number[];
  };
  const vec = result.data?.[0];
  if (!Array.isArray(vec)) {
    throw new Error("embedText: AI binding returned no data row");
  }
  if (vec.length !== MEMORY_EMBED_DIMENSIONS) {
    // Hard fail. A dim mismatch means the model swapped under us
    // (very rare on a versioned id) or the binding is misconfigured.
    // Either way we'd corrupt the Vectorize index by upserting.
    throw new Error(
      `embedText: dim mismatch (got ${vec.length}, expected ${MEMORY_EMBED_DIMENSIONS})`
    );
  }

  // Heartbeat at debug level — useful for cost dashboards.
  logEvent({
    event: "memory.embed",
    level: "debug",
    model: MEMORY_EMBED_MODEL,
    durationMs: Date.now() - startedAt,
    inputChars: text.length,
  });
  return vec;
}

/**
 * Best-effort wrapper for the recall path. Returns null on failure
 * + emits a warn-level event. Use this when an embed failure should
 * degrade gracefully (no recall) rather than aborting the operation.
 */
export async function embedTextOrNull(env: Env, raw: string): Promise<number[] | null> {
  try {
    return await embedText(env, raw);
  } catch (err) {
    logEvent({
      event: "memory.embed_failed",
      level: "warn",
      model: MEMORY_EMBED_MODEL,
      error: truncateMessage(err),
    });
    return null;
  }
}
