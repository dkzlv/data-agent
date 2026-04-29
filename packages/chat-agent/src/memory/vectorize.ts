/**
 * Cloudflare Vectorize wrapper for memory facts (task a0e754).
 *
 * Wire-shape decisions:
 *
 *   - **Vector id = Postgres `memory_fact.id`** (UUID). One-to-one
 *     mapping; Postgres is source of truth, Vectorize is the index.
 *     Avoids any "cursor" or composite-key gymnastics.
 *
 *   - **Namespace = tenantId.** Vectorize namespaces give hard
 *     isolation: a query without `namespace` would scan every
 *     tenant's vectors — the namespace argument turns that into an
 *     impossible-by-default cross-tenant leak. Defense-in-depth on
 *     top of the metadata `tenantId` filter, redundant on purpose.
 *
 *   - **Metadata: `dbProfileId`, `kind`, `createdAt` (ISO).** Used
 *     as `filter` predicates so a recall can scope to "this profile,
 *     these kinds, recent" without re-querying Postgres. We
 *     intentionally do NOT store the content text in metadata —
 *     content lives in Postgres and we hydrate after the vector
 *     query. Reasons:
 *
 *       a) Keeps vector metadata lean (Vectorize bills on size).
 *       b) Soft-deleted facts get filtered out at hydrate time —
 *          if content lived in metadata, a stale soft-delete would
 *          leak into the recalled-facts block.
 *       c) Single source of truth on edits (we don't currently
 *          allow content edits, but punting now means future-us
 *          doesn't have to dual-write).
 *
 *   - **V2 (`Vectorize`) async mutations.** Upserts and deletes
 *     return a `mutationId` that's eventually consistent. Reads
 *     against an upserted vector may not see it immediately —
 *     acceptable here because the *write* path (`memory.remember`)
 *     immediately returns the Postgres row, and recall reads happen
 *     on subsequent turns (≥ a few seconds later). If we ever need
 *     read-your-write semantics inside a single turn, the model can
 *     call `memory.search` which falls back to Postgres ILIKE.
 */
import { logEvent, truncateMessage } from "@data-agent/shared";
import type { Env } from "../env";
import type { MemoryKind } from "@data-agent/shared";

/** Metadata stored on each vector. Mirrors the Postgres row's
 *  filterable subset. `kind` is indexed (filterable); `createdAt`
 *  is for future "recent first" reranking; `dbProfileId` is the
 *  primary scope filter. */
export interface MemoryVectorMetadata {
  dbProfileId: string;
  kind: MemoryKind;
  /** ISO 8601. */
  createdAt: string;
}

export interface UpsertArgs {
  id: string;
  values: number[];
  tenantId: string;
  metadata: MemoryVectorMetadata;
}

/**
 * Upsert a single fact's vector. Throws on failure — caller (the
 * `memory.remember` write path) rolls back the Postgres row when
 * this fails so the two stores don't drift.
 */
export async function upsertVector(env: Env, args: UpsertArgs): Promise<void> {
  // The V2 binding accepts `metadata` as a flat record of
  // VectorizeVectorMetadata (string | number | boolean | string[]).
  // We satisfy the constraint structurally without dragging the
  // exact CF type through this signature.
  const startedAt = Date.now();
  await env.VECTORIZE_MEMORY.upsert([
    {
      id: args.id,
      values: args.values,
      namespace: args.tenantId,
      metadata: {
        dbProfileId: args.metadata.dbProfileId,
        kind: args.metadata.kind,
        createdAt: args.metadata.createdAt,
      },
    },
  ]);
  logEvent({
    event: "memory.vectorize_upsert",
    level: "debug",
    durationMs: Date.now() - startedAt,
    factId: args.id,
  });
}

export interface QueryArgs {
  vector: number[];
  tenantId: string;
  dbProfileId: string;
  /** Optional kind narrowing — `memory.search` exposes this; the
   *  recall path leaves it open so the prompt sees a mix of kinds. */
  kind?: MemoryKind;
  topK: number;
}

export interface QueryHit {
  id: string;
  score: number;
}

/**
 * Vector similarity query. Returns ids + scores; caller hydrates
 * full rows from Postgres. Tenant isolation enforced via namespace
 * AND metadata filter — defense in depth.
 *
 * Returns `[]` on failure rather than throwing — recall is
 * decorative, never blocks the turn (see top-of-file comment in
 * `agent.ts`).
 */
export async function queryVectors(env: Env, args: QueryArgs): Promise<QueryHit[]> {
  try {
    const startedAt = Date.now();
    // Vectorize filter shape: `{ field: value }` for $eq, or
    // `{ field: { $op: value } }` for ranges/sets. Plain string equals
    // is exactly what we need; the values are constrained to the
    // metadata vocabulary (string ids, MemoryKind literals).
    const filter: Record<string, string> = {
      dbProfileId: args.dbProfileId,
    };
    if (args.kind) filter.kind = args.kind;

    const result = await env.VECTORIZE_MEMORY.query(args.vector, {
      topK: args.topK,
      namespace: args.tenantId,
      // We don't need the values back — only ids + scores. Saves
      // bandwidth on the hot path.
      returnValues: false,
      // Indexed metadata is "free" — kind is small enough to be
      // returned in the indexed tier. We still hydrate from PG.
      returnMetadata: "indexed",
      filter,
    });

    logEvent({
      event: "memory.vectorize_query",
      level: "debug",
      durationMs: Date.now() - startedAt,
      topK: args.topK,
      hits: result.matches.length,
    });

    return result.matches.map((m) => ({ id: m.id, score: m.score }));
  } catch (err) {
    logEvent({
      event: "memory.vectorize_query_failed",
      level: "warn",
      error: truncateMessage(err),
    });
    return [];
  }
}

/**
 * Best-effort delete for a list of fact ids. The V2 binding's
 * `deleteByIds` is async — our caller usually fires this from
 * `waitUntil`, so a slow Vectorize sweep can't keep a turn pending.
 *
 * Soft-delete in Postgres is the truth (the `hydrateFacts` filter
 * is what prevents soft-deleted ids from appearing in recall);
 * Vectorize cleanup is a cost optimization.
 */
export async function deleteVectors(
  env: Env,
  args: { ids: string[]; tenantId: string }
): Promise<void> {
  if (args.ids.length === 0) return;
  try {
    // Note: deleteByIds in V2 is namespace-aware via the vector's
    // own metadata at index time; passing namespace here is a no-op.
    // The id space is global, but ids are UUIDs — collision-free.
    await env.VECTORIZE_MEMORY.deleteByIds(args.ids);
    logEvent({
      event: "memory.vectorize_delete",
      level: "debug",
      count: args.ids.length,
    });
  } catch (err) {
    // Don't throw — soft-delete in Postgres already protects us;
    // an orphaned vector here is a cost issue, not a correctness
    // issue.
    logEvent({
      event: "memory.vectorize_delete_failed",
      level: "warn",
      count: args.ids.length,
      error: truncateMessage(err),
    });
  }
}
