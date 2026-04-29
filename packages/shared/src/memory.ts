/**
 * Memory types + content normalization (task a0e754).
 *
 * Lives in `@data-agent/shared` because three packages need them:
 *   - `db` schema infers `MemoryFact` from Drizzle (the canonical
 *     row shape) but the *kind* enum value list is shared with web
 *     and api-gateway, who never touch the Drizzle schema directly.
 *   - `chat-agent` uses normalize/hash on every write to drive the
 *     dedupe unique index in `memory_fact`.
 *   - `web` renders kind badges + types the REST response.
 *
 * Source of truth for the enum is `db/src/schema/memory.ts`'s
 * `memoryKind` pgEnum, but we duplicate the literal here because
 * `shared` can't import from `db` (would create a cycle: db depends
 * on shared for `encryption`, etc.). A unit test in `shared` locks
 * the two lists together; if you add a kind in db, add it here too
 * or the test fails.
 */

/**
 * Fact taxonomy. Mirrors `db/src/schema/memory.ts`'s `memoryKind`
 * enum exactly. Kept as a tuple-literal so TypeScript narrows
 * properly and the runtime list is a value too (used for UI chips).
 */
export const MEMORY_KINDS = [
  "schema_semantic",
  "business_def",
  "user_pref",
  "query_pattern_good",
  "query_pattern_bad",
  "entity",
  "chat_summary",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Cheap O(1) check for runtime-typed inputs (REST + tool args). */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

/** UI labels for `kind` chips. Kept short (≤2 words). */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  schema_semantic: "Schema",
  business_def: "Business",
  user_pref: "Preference",
  query_pattern_good: "Pattern",
  query_pattern_bad: "Anti-pattern",
  entity: "Entity",
  chat_summary: "Summary",
};

/**
 * Hard caps for model-supplied content. Hard floor of 10 chars
 * rejects "ok" / "yes" style noise.
 *
 * The 2000-char ceiling (was 500 — task 996861) accommodates
 * schema-shaped facts. A "schema_semantic" fact for a single table
 * + column commentary + a couple of business rules trivially clears
 * 500 chars; the earlier cap caused the entire `for (const f of
 * candidates) memory.remember(f)` codemode loop to throw on the
 * first fact and silently drop *all* of them (no audit row, no log,
 * see chat 5f2690a6...). bge-base-en-v1.5 has a 512-token window,
 * which translates to roughly 1500–2000 chars of normal English —
 * the embed path (`MAX_EMBED_INPUT_CHARS = 1500` in
 * `chat-agent/memory/embed.ts`) clips at 1500 anyway, so anything
 * above that is stored verbatim in Postgres but indexed on the
 * prefix only. That's fine for retrieval: schema/business facts
 * carry their most discriminative signal in the first sentence
 * (table name, key term).
 *
 * If you raise this further, also raise `MAX_EMBED_INPUT_CHARS`
 * with eyes open — bge's 512-token ceiling is hard, so feeding it
 * more bytes only burns Workers AI tokens for zero recall benefit.
 *
 * Enforced at write time in `memory.remember` and `persistFact`.
 */
export const MEMORY_CONTENT_MIN = 10;
export const MEMORY_CONTENT_MAX = 2000;

/**
 * Normalize content for hashing. Lowercase + collapsed whitespace
 * means "Total cents not dollars" and "total  cents not dollars\n"
 * dedupe to the same row. We don't strip punctuation — sometimes
 * the punctuation IS the meaning ("MRR != ARR", different fact
 * from "MRR = ARR").
 *
 * Returns the trimmed-but-display-cased content alongside the
 * normalized form so callers can keep readability while hashing on
 * the canonical form.
 */
export function normalizeContent(raw: string): {
  display: string;
  normalized: string;
} {
  const display = raw.trim().replace(/\s+/g, " ");
  const normalized = display.toLowerCase();
  return { display, normalized };
}

/**
 * Compute a sha256 of the normalized content. Returned as 64-char
 * lowercase hex so we can store it in a `text` column without any
 * encoding gymnastics. Crypto.subtle is available everywhere we run
 * (Workers, Node 22+, Bun).
 */
export async function hashContent(normalized: string): Promise<string> {
  const enc = new TextEncoder().encode(normalized);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Validate model-supplied content. Returns `{ ok: true, ... }` with
 * the normalized + display forms for callers to use directly, or
 * `{ ok: false, reason }` so the tool can surface a structured error
 * to the model and let it retry.
 *
 * The reasons are written to be model-readable: short, action-oriented.
 */
export type ValidateResult =
  | { ok: true; display: string; normalized: string }
  | { ok: false; reason: string };

export function validateMemoryContent(raw: unknown): ValidateResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "content must be a string" };
  }
  const { display, normalized } = normalizeContent(raw);
  if (display.length < MEMORY_CONTENT_MIN) {
    return {
      ok: false,
      reason: `content is too short (${display.length} chars; minimum ${MEMORY_CONTENT_MIN})`,
    };
  }
  if (display.length > MEMORY_CONTENT_MAX) {
    return {
      ok: false,
      reason: `content is too long (${display.length} chars; maximum ${MEMORY_CONTENT_MAX}). Break it into multiple narrow facts (one concept per fact) instead of one mega-fact.`,
    };
  }
  return { ok: true, display, normalized };
}

/**
 * Wire-shape returned by REST + WS frames + tools. Subset of the
 * Drizzle row — we never expose `tenantId` (caller already knows it
 * from the session) or `contentHash` (internal dedupe key). `score`
 * is only present on search/recall responses.
 */
export interface MemoryFactView {
  id: string;
  kind: MemoryKind;
  content: string;
  payload: Record<string, unknown> | null;
  dbProfileId: string;
  sourceChatId: string | null;
  sourceTurnId: string | null;
  hitCount: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  lastUsedAt: string | null; // ISO
  /** Only on search/recall responses. */
  score?: number;
}

/**
 * Embedding model id. Shared between embed.ts and the env-shape
 * probe in `spike-memory.ts`. Centralized so a model swap touches
 * exactly one constant — *but* a swap also forces a re-embed of
 * existing facts, since vector dimensions and embedding distribution
 * are model-specific.
 *
 * `bge-base-en-v1.5` is 768-d, English, decent on short factual
 * text. Free Workers AI binding.
 */
export const MEMORY_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const MEMORY_EMBED_DIMENSIONS = 768;
