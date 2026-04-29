/**
 * Drizzle CRUD for `memory_fact` (task a0e754).
 *
 * The store is the *only* module that touches the `memory_fact`
 * table directly — `retrieve.ts`, `tools.ts`, and `extract.ts` go
 * through these helpers so the tenant-isolation predicate and the
 * dedupe UPSERT shape live in one place.
 *
 * Lifecycle of a fact:
 *
 *   persistFact (UPSERT on dbProfileId+contentHash)
 *     → returns { row, inserted: bool }
 *     → caller embeds + upserts into Vectorize iff `inserted: true`
 *
 *   bumpHits (waitUntil) — fired after a recall
 *
 *   softDelete — flips `deleted_at` so the chip's "Undo" still has
 *     a window. Hard-delete cron sweep is post-MVP.
 *
 * Tenant isolation: every read filters on `tenantId`. We pass it
 * explicitly rather than reading from a session because the chat-
 * agent is shared across tenants (DO name = chatId, not tenantId).
 *
 * Connection management: each call opens a fresh `max=1` pool and
 * closes it eagerly (same pattern as `auditFromAgent` and
 * `summarizeAndPersistTitle`). Memory operations are infrequent
 * (1-2 per turn at most), so the connection-open overhead is below
 * the noise floor of a single Postgres round-trip.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createDbClient, schema } from "@data-agent/db";
import type { MemoryFact } from "@data-agent/db/schema";
import {
  hashContent,
  type MemoryFactView,
  type MemoryKind,
  normalizeContent,
} from "@data-agent/shared";
import { readSecret, type Env } from "../env";

/**
 * Per-dbProfile cap. Beyond this, `persistFact` returns `cap_reached`
 * and the model gets an error envelope so it knows to stop trying.
 * Picked generously — we'd rather collect noise than cut off a power
 * user; the diversity rerank in retrieval handles the noise.
 */
export const MEMORY_FACTS_PER_PROFILE_CAP = 5_000;

/**
 * Inputs for `persistFact`. The shape mirrors what the model sends
 * via `memory.remember` plus the always-present audit attribution
 * (tenantId, dbProfileId, sourceChatId/turnId).
 */
export interface PersistFactInputs {
  tenantId: string;
  dbProfileId: string;
  kind: MemoryKind;
  /** Already validated & normalized content (display-cased). */
  content: string;
  /** Optional structured payload — SQL for patterns, etc. */
  payload?: Record<string, unknown> | null;
  sourceChatId: string | null;
  sourceTurnId: string | null;
  createdBy: string | null;
}

export type PersistFactResult =
  | { ok: true; inserted: boolean; revivedFromSoftDelete: boolean; row: MemoryFact }
  | { ok: false; reason: "cap_reached"; cap: number };

/**
 * UPSERT a fact, dedupe on `(dbProfileId, contentHash)`.
 *
 * Returns `inserted: true` only when a new row was created (so the
 * caller knows to embed + upsert into Vectorize). When the same
 * normalized content was saved before, we bump `updatedAt` and
 * `sourceChatId/turnId` to the most recent reference, return the
 * existing row with `inserted: false`, and skip the embed call.
 *
 * If the existing row was soft-deleted, we revive it (clear
 * `deletedAt`) — the user/agent re-asserting a fact they once
 * forgot is the closest thing we have to undo on the data side.
 *
 * Cap check is opportunistic — a parallel writer can race past it,
 * but the cap is meant as a soft guard against the model running
 * away with `remember` calls, not a strict accounting boundary.
 */
export async function persistFact(env: Env, inputs: PersistFactInputs): Promise<PersistFactResult> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    // Cap probe — only when adding (we don't gate updates).
    const [{ count }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.memoryFact)
      .where(
        and(
          eq(schema.memoryFact.dbProfileId, inputs.dbProfileId),
          isNull(schema.memoryFact.deletedAt)
        )
      )) as [{ count: number }];

    const { display, normalized } = normalizeContent(inputs.content);
    const contentHash = await hashContent(normalized);

    // Look up existing row (alive or soft-deleted) so we can decide
    // between "insert + embed" and "update in place".
    const existing = await db
      .select()
      .from(schema.memoryFact)
      .where(
        and(
          eq(schema.memoryFact.dbProfileId, inputs.dbProfileId),
          eq(schema.memoryFact.contentHash, contentHash)
        )
      )
      .limit(1);

    if (existing[0]) {
      // Update path — refresh attribution, revive if soft-deleted.
      const wasSoftDeleted = existing[0].deletedAt !== null;
      const [updated] = await db
        .update(schema.memoryFact)
        .set({
          updatedAt: new Date(),
          sourceChatId: inputs.sourceChatId,
          sourceTurnId: inputs.sourceTurnId,
          // Revive on re-assert.
          deletedAt: null,
          // Keep the canonical display form fresh.
          content: display,
          payload: inputs.payload ?? existing[0].payload,
        })
        .where(eq(schema.memoryFact.id, existing[0].id))
        .returning();
      return {
        ok: true,
        inserted: false,
        revivedFromSoftDelete: wasSoftDeleted,
        row: updated!,
      };
    }

    if (count >= MEMORY_FACTS_PER_PROFILE_CAP) {
      return { ok: false, reason: "cap_reached", cap: MEMORY_FACTS_PER_PROFILE_CAP };
    }

    const [inserted] = await db
      .insert(schema.memoryFact)
      .values({
        tenantId: inputs.tenantId,
        dbProfileId: inputs.dbProfileId,
        kind: inputs.kind,
        content: display,
        contentHash,
        payload: inputs.payload ?? null,
        sourceChatId: inputs.sourceChatId,
        sourceTurnId: inputs.sourceTurnId,
        createdBy: inputs.createdBy,
      })
      .returning();

    return {
      ok: true,
      inserted: true,
      revivedFromSoftDelete: false,
      row: inserted!,
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Soft-delete a fact. Returns the row's id + tenantId on success
 * (caller uses tenantId to scope the Vectorize delete). Returns
 * null when the id doesn't exist or belongs to another tenant —
 * idempotent + safe.
 *
 * `idOrHash` accepts either a UUID id (preferred) or a normalized
 * content string we hash on the fly. The model uses the hash path
 * when it wants to forget a fact it generated *in this turn* and
 * doesn't have the id yet.
 */
export async function softDeleteFact(
  env: Env,
  args: {
    tenantId: string;
    dbProfileId: string;
    idOrHash: { kind: "id"; value: string } | { kind: "content"; value: string };
  }
): Promise<{ id: string; tenantId: string } | null> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    let predicate: SQL;
    if (args.idOrHash.kind === "id") {
      predicate = eq(schema.memoryFact.id, args.idOrHash.value);
    } else {
      const { normalized } = normalizeContent(args.idOrHash.value);
      const hash = await hashContent(normalized);
      predicate = eq(schema.memoryFact.contentHash, hash);
    }
    const [row] = await db
      .update(schema.memoryFact)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          predicate,
          eq(schema.memoryFact.tenantId, args.tenantId),
          eq(schema.memoryFact.dbProfileId, args.dbProfileId),
          // Idempotent: don't double-stamp.
          isNull(schema.memoryFact.deletedAt)
        )
      )
      .returning({ id: schema.memoryFact.id, tenantId: schema.memoryFact.tenantId });
    return row ?? null;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Hydrate a list of ids into full fact rows, scoped to tenant +
 * dbProfile + alive. Used by `retrieve.ts` after a Vectorize query
 * returns ids — Vectorize may still return a soft-deleted id that
 * hasn't been swept from the index yet, so the alive filter here is
 * the gate.
 *
 * Order is *not* preserved — caller re-sorts by Vectorize score.
 */
export async function hydrateFacts(
  env: Env,
  args: {
    tenantId: string;
    dbProfileId: string;
    ids: string[];
  }
): Promise<MemoryFact[]> {
  if (args.ids.length === 0) return [];
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    return await db
      .select()
      .from(schema.memoryFact)
      .where(
        and(
          inArray(schema.memoryFact.id, args.ids),
          eq(schema.memoryFact.tenantId, args.tenantId),
          eq(schema.memoryFact.dbProfileId, args.dbProfileId),
          isNull(schema.memoryFact.deletedAt)
        )
      );
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Bump `hit_count` + `last_used_at` on a list of recalled facts.
 * Fired from `waitUntil` after the system prompt is injected — never
 * blocks the turn. A failure here costs us curation accuracy on the
 * next recall, nothing more.
 */
export async function bumpHits(env: Env, args: { tenantId: string; ids: string[] }): Promise<void> {
  if (args.ids.length === 0) return;
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    await db
      .update(schema.memoryFact)
      .set({
        hitCount: sql`${schema.memoryFact.hitCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(
        and(inArray(schema.memoryFact.id, args.ids), eq(schema.memoryFact.tenantId, args.tenantId))
      );
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** Cursor-paginated list for the management UI. */
export interface ListFactsArgs {
  tenantId: string;
  dbProfileId: string;
  kind?: MemoryKind | null;
  /** ILIKE substring on content. Empty string ignored. */
  q?: string | null;
  /** Opaque cursor: ISO `createdAt` of the last row from the previous page. */
  cursor?: string | null;
  /** Page size; clamped to [1, 100]. Default 50. */
  limit?: number;
}

export interface ListFactsResult {
  facts: MemoryFact[];
  nextCursor: string | null;
}

/** List facts for the management UI. Newest-first. */
export async function listFacts(env: Env, args: ListFactsArgs): Promise<ListFactsResult> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    const conditions: SQL[] = [
      eq(schema.memoryFact.tenantId, args.tenantId),
      eq(schema.memoryFact.dbProfileId, args.dbProfileId),
      isNull(schema.memoryFact.deletedAt),
    ];
    if (args.kind) conditions.push(eq(schema.memoryFact.kind, args.kind));
    if (args.q && args.q.trim()) {
      // Postgres ILIKE; we treat the raw input as a pattern fragment
      // and wrap with %. The user-facing input is sanitized at the
      // route layer (Zod string).
      const pattern = `%${args.q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(sql`${schema.memoryFact.content} ILIKE ${pattern}`);
    }
    if (args.cursor) {
      const cursorDate = new Date(args.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        conditions.push(sql`${schema.memoryFact.createdAt} < ${cursorDate}`);
      }
    }

    const rows = await db
      .select()
      .from(schema.memoryFact)
      .where(and(...conditions))
      .orderBy(desc(schema.memoryFact.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      facts: page,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** Get one fact by id, scoped to tenant. Returns null on miss. */
export async function getFactById(
  env: Env,
  args: { tenantId: string; id: string }
): Promise<MemoryFact | null> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    const [row] = await db
      .select()
      .from(schema.memoryFact)
      .where(and(eq(schema.memoryFact.id, args.id), eq(schema.memoryFact.tenantId, args.tenantId)))
      .limit(1);
    return row ?? null;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** Total fact count for a profile (alive only). Used by the UI header. */
export async function countFacts(
  env: Env,
  args: { tenantId: string; dbProfileId: string }
): Promise<number> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    const [row] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.memoryFact)
      .where(
        and(
          eq(schema.memoryFact.tenantId, args.tenantId),
          eq(schema.memoryFact.dbProfileId, args.dbProfileId),
          isNull(schema.memoryFact.deletedAt)
        )
      )) as [{ count: number }];
    return row?.count ?? 0;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Project a Drizzle row to the wire-shape exposed to clients (REST
 * + WS broadcast + tool returns). Strips internal fields
 * (tenantId, contentHash) and turns dates into ISO strings.
 */
export function toView(row: MemoryFact, score?: number): MemoryFactView {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    payload: row.payload,
    dbProfileId: row.dbProfileId,
    sourceChatId: row.sourceChatId,
    sourceTurnId: row.sourceTurnId,
    hitCount: row.hitCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    ...(typeof score === "number" ? { score } : {}),
  };
}

/**
 * Hard-delete every fact for a dbProfile (cascade on tenant- or
 * profile-deletion will cover this for normal flows; this is for
 * `debug-memory-clear.ts`). Returns the deleted ids so the caller
 * can scrub Vectorize too.
 */
export async function hardDeleteAllForProfile(
  env: Env,
  args: { tenantId: string; dbProfileId: string }
): Promise<string[]> {
  const url = await readSecret(env.CONTROL_PLANE_DB_URL);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    const rows = await db
      .delete(schema.memoryFact)
      .where(
        and(
          eq(schema.memoryFact.tenantId, args.tenantId),
          eq(schema.memoryFact.dbProfileId, args.dbProfileId)
        )
      )
      .returning({ id: schema.memoryFact.id });
    return rows.map((r) => r.id);
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
