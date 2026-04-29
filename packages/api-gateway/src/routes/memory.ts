/**
 * Memory management REST surface (task a0e754).
 *
 *   GET    /api/memory?dbProfileId=&kind=&q=&cursor=    list facts (paginated)
 *   GET    /api/memory/:id                              one fact
 *   DELETE /api/memory/:id                              soft-delete + Vectorize scrub
 *
 * What's NOT exposed (and why):
 *   - **Create.** Memory is built automatically by the chat agent
 *     and the post-turn extractor. Manual user creation would need
 *     a meaningful UI affordance ("paste a fact") and the spec
 *     explicitly defers it ("read-only UI v1"). When that lands,
 *     it'll go through the same `persistFact` helper as the agent
 *     so the dedupe+embed pipeline is shared.
 *   - **Edit.** Same reasoning — delete + recreate covers the
 *     correction path, and avoids edit-vs-revive UX ambiguity.
 *   - **Vector search.** The recall/search path lives server-side
 *     (chat-agent) on purpose — exposing similarity search to
 *     external HTTP would let an attacker probe what's saved
 *     without pulling rows. The list endpoint takes an ILIKE `q`
 *     for *substring* search, which is enough for the management
 *     UI's "find that fact about orders" workflow.
 *
 * Tenant isolation: every query filters on `c.var.session.tenantId`.
 * dbProfile ownership is verified via a join — a request for a
 * profile that doesn't belong to this tenant returns 404 (we
 * don't distinguish "doesn't exist" from "exists but yours not"
 * to avoid leaking either way).
 */
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@data-agent/db";
import { logEvent, MEMORY_KINDS, truncateMessage, type MemoryFactView } from "@data-agent/shared";
import { writeAudit } from "../audit";
import type { Env } from "../env";
import { requireSession, type RequestSession } from "../session";

type Vars = { session: RequestSession };

export const memoryRouter = new Hono<{ Bindings: Env; Variables: Vars }>();
memoryRouter.use("*", requireSession());

const listQuerySchema = z.object({
  dbProfileId: z.string().uuid(),
  kind: z.enum(MEMORY_KINDS).optional(),
  q: z.string().min(1).max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Project a fact row to wire shape. Mirrors `chat-agent/memory/store.ts`'s
 * `toView` — duplicated here (rather than imported) because the
 * chat-agent isn't a dependency of the api-gateway. The shape is
 * pinned by `MemoryFactView` from `@data-agent/shared`.
 */
function rowToView(row: {
  id: string;
  kind: (typeof MEMORY_KINDS)[number];
  content: string;
  payload: Record<string, unknown> | null;
  dbProfileId: string;
  sourceChatId: string | null;
  sourceTurnId: string | null;
  hitCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}): MemoryFactView {
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
  };
}

/**
 * Verify the dbProfile belongs to the requesting tenant and isn't
 * soft-deleted. Returns the profile id on success, null on miss.
 *
 * Returning the id (rather than just a boolean) lets the caller
 * pass it back into queries without re-validating the input.
 */
async function assertProfileOwnership(
  session: RequestSession,
  dbProfileId: string
): Promise<{ ok: true; id: string } | { ok: false }> {
  const [profile] = await session.db
    .select({ id: schema.dbProfile.id })
    .from(schema.dbProfile)
    .where(
      and(
        eq(schema.dbProfile.id, dbProfileId),
        eq(schema.dbProfile.tenantId, session.tenantId),
        isNull(schema.dbProfile.deletedAt)
      )
    )
    .limit(1);
  return profile ? { ok: true, id: profile.id } : { ok: false };
}

// List facts for a dbProfile. Paginated, filterable by kind +
// substring. Returns alive (non-soft-deleted) rows newest-first.
memoryRouter.get("/", async (c) => {
  const params = listQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!params.success) {
    return c.json({ error: "bad_request", issues: params.error.issues }, 400);
  }
  const session = c.var.session;
  const { dbProfileId, kind, q, cursor, limit } = params.data;

  const owned = await assertProfileOwnership(session, dbProfileId);
  if (!owned.ok) return c.json({ error: "not_found" }, 404);

  const conds: SQL[] = [
    eq(schema.memoryFact.tenantId, session.tenantId),
    eq(schema.memoryFact.dbProfileId, dbProfileId),
    isNull(schema.memoryFact.deletedAt),
  ];
  if (kind) conds.push(eq(schema.memoryFact.kind, kind));
  if (q) {
    // Escape ILIKE special chars so a literal `%` in the query doesn't
    // turn the search wildcard. The db-level pattern is still
    // `%escaped%` for substring containment.
    const pattern = `%${q.trim().replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(sql`${schema.memoryFact.content} ILIKE ${pattern}`);
  }
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conds.push(sql`${schema.memoryFact.createdAt} < ${cursorDate}`);
    }
  }

  const rows = await session.db
    .select({
      id: schema.memoryFact.id,
      kind: schema.memoryFact.kind,
      content: schema.memoryFact.content,
      payload: schema.memoryFact.payload,
      dbProfileId: schema.memoryFact.dbProfileId,
      sourceChatId: schema.memoryFact.sourceChatId,
      sourceTurnId: schema.memoryFact.sourceTurnId,
      hitCount: schema.memoryFact.hitCount,
      createdAt: schema.memoryFact.createdAt,
      updatedAt: schema.memoryFact.updatedAt,
      lastUsedAt: schema.memoryFact.lastUsedAt,
    })
    .from(schema.memoryFact)
    .where(and(...conds))
    .orderBy(desc(schema.memoryFact.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // Total count for the UI header — alive + same scope. Cheap on a
  // small index; the (dbProfileId, deletedAt) covering index from
  // the schema fits this exact predicate.
  const [{ count }] = (await session.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.memoryFact)
    .where(
      and(
        eq(schema.memoryFact.tenantId, session.tenantId),
        eq(schema.memoryFact.dbProfileId, dbProfileId),
        isNull(schema.memoryFact.deletedAt)
      )
    )) as [{ count: number }];

  return c.json({
    facts: page.map(rowToView),
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    total: count,
  });
});

// Get one — for the "view fact details" surface. Tenant-scoped.
memoryRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const session = c.var.session;
  const [row] = await session.db
    .select({
      id: schema.memoryFact.id,
      kind: schema.memoryFact.kind,
      content: schema.memoryFact.content,
      payload: schema.memoryFact.payload,
      dbProfileId: schema.memoryFact.dbProfileId,
      sourceChatId: schema.memoryFact.sourceChatId,
      sourceTurnId: schema.memoryFact.sourceTurnId,
      hitCount: schema.memoryFact.hitCount,
      createdAt: schema.memoryFact.createdAt,
      updatedAt: schema.memoryFact.updatedAt,
      lastUsedAt: schema.memoryFact.lastUsedAt,
      deletedAt: schema.memoryFact.deletedAt,
    })
    .from(schema.memoryFact)
    .where(and(eq(schema.memoryFact.id, id), eq(schema.memoryFact.tenantId, session.tenantId)))
    .limit(1);

  if (!row || row.deletedAt) return c.json({ error: "not_found" }, 404);
  return c.json(rowToView(row));
});

// Soft-delete a fact + scrub the vector. Idempotent — calling twice
// on the same id returns 200 the first time and 404 the second.
memoryRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const session = c.var.session;

  const [updated] = await session.db
    .update(schema.memoryFact)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.memoryFact.id, id),
        eq(schema.memoryFact.tenantId, session.tenantId),
        isNull(schema.memoryFact.deletedAt)
      )
    )
    .returning({
      id: schema.memoryFact.id,
      dbProfileId: schema.memoryFact.dbProfileId,
    });

  if (!updated) return c.json({ error: "not_found" }, 404);

  // Vectorize scrub via waitUntil — the user response doesn't wait
  // on Vectorize. A failure here just leaves an orphan vector
  // (Postgres soft-delete is the truth, hydrate filters it out).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.VECTORIZE_MEMORY.deleteByIds([id]);
      } catch (err) {
        logEvent({
          event: "memory.vectorize_delete_failed",
          level: "warn",
          source: "api-gateway",
          factId: id,
          tenantId: session.tenantId,
          error: truncateMessage(err),
        });
      }
    })()
  );

  c.executionCtx.waitUntil(
    writeAudit(session.db, {
      tenantId: session.tenantId,
      userId: session.user.id,
      action: "memory.forget",
      target: id,
      payload: { dbProfileId: updated.dbProfileId, source: "ui" },
    })
  );

  return c.json({ ok: true });
});
