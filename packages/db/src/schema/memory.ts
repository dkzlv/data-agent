/**
 * Cross-chat memory: durable facts the agent extracts from chats so
 * future turns over the same dbProfile recall what was learned (task
 * a0e754).
 *
 * Source of truth lives here in Postgres; Cloudflare Vectorize holds
 * the embeddings index keyed by `id`. Tenant + dbProfile are the
 * primary scopes — facts NEVER leak across tenants (isolation enforced
 * twice: namespace on the vector side, `tenant_id` filter on the
 * Postgres side; redundant on purpose).
 *
 * Why this shape:
 *   - One table, `kind` enum disambiguates retrieval/UI grouping.
 *     Avoids the polymorphism a per-kind-table approach would force
 *     onto every join.
 *   - `content_hash` (sha256 of normalized content) is the dedupe
 *     key. UPSERT collapses re-saves of the same fact to the same row,
 *     bumping `updated_at` instead of accumulating duplicates.
 *   - `hit_count` + `last_used_at` are the curation signals: facts
 *     that get recalled often outrank stale ones in topK. Bumped on
 *     recall via `waitUntil`.
 *   - Soft-delete (`deleted_at`) so the "Undo" chip in the chat UI
 *     can revive a fact within the retention window. A nightly cron
 *     hard-deletes rows ≥7d post soft-delete (post-MVP; for now
 *     soft-only).
 *   - `payload` carries kind-specific structured data: SQL for
 *     query_pattern_*, source attribution, etc. Read-only from the
 *     UI; the Drizzle column type pins it to a JSON object.
 */
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { chat } from "./chat";
import { dbProfile } from "./db-profile";
import { tenant } from "./tenant";

/**
 * Fact taxonomy. Kept explicit (not a free-form string) so the model
 * can't invent kinds, the UI can group reliably, and retrieval can
 * narrow by kind without a substring match.
 *
 * - `schema_semantic`     — column meaning the schema doesn't reveal
 *                           ("orders.total_cents is in cents")
 * - `business_def`        — formula or business rule
 *                           ("MRR = sum(active_subscriptions.amount)")
 * - `user_pref`           — analytical preference
 *                           ("always exclude test tenants")
 * - `query_pattern_good`  — working SQL + the question class it answers
 * - `query_pattern_bad`   — failing SQL + reason (so we don't repeat)
 * - `entity`              — identifier mappings ("Acme = customer 1234")
 * - `chat_summary`        — 1-paragraph TL;DR per chat
 */
export const memoryKind = pgEnum("memory_kind", [
  "schema_semantic",
  "business_def",
  "user_pref",
  "query_pattern_good",
  "query_pattern_bad",
  "entity",
  "chat_summary",
]);

export type MemoryKind = (typeof memoryKind.enumValues)[number];

export const memoryFact = pgTable(
  "memory_fact",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    dbProfileId: text("db_profile_id")
      .notNull()
      .references(() => dbProfile.id, { onDelete: "cascade" }),
    kind: memoryKind("kind").notNull(),
    /** Human-readable fact, 10..500 chars. Plain English; what the
     *  model gets in the recalled-facts block of the system prompt. */
    content: text("content").notNull(),
    /** Kind-specific structured payload — SQL for patterns, source
     *  metadata for summaries, etc. Read-only from the UI. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Source chat for auditing + UI back-link. `set null` so a
     *  deleted chat doesn't cascade-wipe its facts. */
    sourceChatId: text("source_chat_id").references(() => chat.id, { onDelete: "set null" }),
    /** Matches the obs `turnId` envelope so an operator can grep
     *  Workers Logs for the turn that created the fact. */
    sourceTurnId: text("source_turn_id"),
    /** User attribution (who said it, or null for extracted facts). */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** sha256 of normalized content (lowercase + collapsed whitespace).
     *  Used by the dedupe unique index — same fact saved twice from
     *  two chats collapses to one row with a bumped updatedAt. */
    contentHash: text("content_hash").notNull(),
    /** Bumped on every recall (waitUntil). Powers the curation rerank
     *  — frequently-used facts outrank stale ones. */
    hitCount: integer("hit_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Soft-delete; the "Undo" chip in chat reads this to know whether
     *  the fact can still be revived. Cron sweep (post-MVP) hard-
     *  deletes ≥7d after soft-delete. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Most reads are "list facts for this dbProfile, alive only".
    index("memory_fact_profile_idx").on(t.dbProfileId, t.deletedAt),
    // Tenant scope check on every read — separate index so a tenant
    // sweep (e.g. account-deletion cascade verify) doesn't have to
    // scan all profiles.
    index("memory_fact_tenant_idx").on(t.tenantId),
    // Dedupe key. UPSERT clauses target this index by name.
    uniqueIndex("memory_fact_dedupe_idx").on(t.dbProfileId, t.contentHash),
  ]
);

export type MemoryFact = typeof memoryFact.$inferSelect;
export type NewMemoryFact = typeof memoryFact.$inferInsert;
