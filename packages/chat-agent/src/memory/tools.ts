/**
 * `memory.*` ToolProvider — exposes write/forget/search to the
 * codemode sandbox (task a0e754).
 *
 * The model sees three operations:
 *
 *   await memory.remember({ kind: "schema_semantic", content: "..." })
 *     → { id, kind, content }
 *
 *   await memory.forget("fact_id_or_content_string")
 *     → { id, ok: true }
 *
 *   await memory.search("question text", { topK?: 6, kind?: "..." })
 *     → Array<{ id, kind, content, score }>
 *
 * Why expose this at all (vs. only the post-turn extractor)?
 *   - Some facts are *explicit* — the user literally says "remember
 *     that MRR uses active subscriptions". The model should save
 *     those proactively, not wait for the extractor's best guess.
 *   - `search` lets the model pull *additional* context the system-
 *     prompt recall didn't surface (e.g. when answering a follow-up
 *     about a different table).
 *   - `forget` is the user's correction channel: "no, that's not
 *     right" → model resaves with the corrected fact + forgets the
 *     old one.
 *
 * Per-turn cap (3 remembers) prevents the model from running away
 * with saves. The cap is enforced by the runtime counter on the
 * agent host (see `MemoryToolHost.bumpRememberCount`).
 *
 * Failure mode: every error is surfaced to the model as a thrown
 * Error with a structured `code` + `message`. The codemode wrapper
 * already catches throws and turns them into `{ error, recoverable }`
 * results so the model can adapt next turn — same recovery path as
 * `db.query` errors.
 */
import type { ToolProvider } from "@cloudflare/codemode";
import {
  isMemoryKind,
  validateMemoryContent,
  type MemoryFactView,
  type MemoryKind,
} from "@data-agent/shared";
import { logEvent, truncateMessage } from "@data-agent/shared";
import type { Env } from "../env";
import { embedText, embedTextOrNull } from "./embed";
import { hydrateFacts, persistFact, softDeleteFact, toView } from "./store";
import { deleteVectors, queryVectors, upsertVector } from "./vectorize";

/** Hard cap on `remember` calls per turn. Prevents the model from
 *  saving 30 facts in one turn after a single user statement. */
export const REMEMBER_CALLS_PER_TURN = 3;

/**
 * Surface the agent host needs to expose to the tool. Kept narrow so
 * the tool stays unit-testable with a fake host.
 *
 * `tenantId` and `dbProfileId` are functions (not values) because
 * they're resolved lazily on the agent — by the time `getTools()`
 * builds the provider, the chat-context cache may not be filled yet,
 * but by the time the model *calls* a tool inside a turn, it
 * always is.
 */
export interface MemoryToolHost {
  /** Resolved chat tenant — null when control-plane unreachable. */
  tenantId(): string | null;
  /** Attached profile — null means memory is disabled for this chat. */
  dbProfileId(): string | null;
  /** Last-sender attribution. Stamped onto `createdBy` for explicit
   *  saves. Null in pre-turn / non-message contexts. */
  userId(): string | null;
  /** Source chat id (== DO name). */
  chatId(): string;
  /** Current turn id, for source-link debugging. */
  turnId(): string | null;
  /** Bump per-turn counter; returns the new value. The tool checks
   *  it against `REMEMBER_CALLS_PER_TURN` and rejects beyond. */
  bumpRememberCount(): number;
  /** Schedule a side-effect (audit write, hit bump) without
   *  blocking the turn. */
  waitUntil(p: Promise<unknown>): void;
  /**
   * Broadcast a memory-write event to the chat's WebSocket clients
   * so the UI can render the "Remembered: ..." chip inline. Caller
   * encodes the JSON; the host just relays.
   */
  broadcast(json: string): void;
  /** Best-effort audit insert. Same shape as the agent's TurnLogger
   *  audit method. The tool fires it via waitUntil after every
   *  memory operation. */
  audit(action: string, target: string | null, payload: Record<string, unknown> | null): void;
}

const TYPES = `
declare const memory: {
  /**
   * Save a durable fact about *this* database for future chats.
   *
   * Use this when the user tells you something that will matter on
   * later turns (or in later chats over the same DB) — schema
   * clarifications, business definitions, preferences, working
   * query patterns. Keep facts FOCUSED (10-2000 chars; aim for one
   * concept per fact, not a full schema dump — multiple narrow
   * facts beat one mega-fact for retrieval), self-contained, and
   * de-contextualized — write them so a future you, with no memory
   * of this chat, would understand them at a glance.
   *
   * Don't save one-off requests ("show me top 10 customers"); save
   * the *general knowledge* you'd want to reuse ("'top customers'
   * usually means by gross_revenue this fiscal quarter").
   *
   * Idempotent: saving the same content twice updates the existing
   * row instead of duplicating.
   */
  remember(args: {
    kind:
      | "schema_semantic"
      | "business_def"
      | "user_pref"
      | "query_pattern_good"
      | "query_pattern_bad"
      | "entity";
    content: string;
    payload?: Record<string, unknown>;
  }): Promise<{ id: string; kind: string; content: string }>;

  /**
   * Soft-delete a saved fact. Pass either the fact id (preferred,
   * returned by \`remember\`) or the content string verbatim.
   *
   * Use this when the user corrects something you previously saved.
   * No-op when the fact doesn't exist.
   */
  forget(idOrContent: string): Promise<{ id: string; ok: true }>;

  /**
   * Find facts about this database via semantic similarity. Useful
   * when the system-prompt recall didn't include what you need
   * (e.g. you're answering a follow-up about a different table).
   *
   * Returns up to \`topK\` facts (default 6) with relevance scores.
   * Only this database's facts are searchable; cross-DB leakage is
   * impossible by design.
   */
  search(query: string, opts?: {
    topK?: number;
    kind?:
      | "schema_semantic"
      | "business_def"
      | "user_pref"
      | "query_pattern_good"
      | "query_pattern_bad"
      | "entity"
      | "chat_summary";
  }): Promise<Array<{
    id: string;
    kind: string;
    content: string;
    score: number;
  }>>;
};
`;

/**
 * Build the `memory.*` provider. Returns `null` when the chat has
 * no dbProfile — registering an absent provider would let the model
 * call a tool whose results have no anchor (no profile to scope to).
 *
 * Caller (build.ts) reads the null and simply doesn't add the
 * provider to the capabilities list; the typed declarations also
 * don't appear, so the model never sees memory APIs that wouldn't
 * work.
 */
export function memoryTools(env: Env, host: MemoryToolHost): ToolProvider | null {
  if (!host.dbProfileId() || !host.tenantId()) return null;

  /**
   * Single point of departure for every `memory.remember` reject
   * path (task 996861). Before this existed each reject was a bare
   * `throw new Error(...)` — the codemode wrapper caught it, the
   * model saw `{error, recoverable: true}`, and *nothing else*
   * happened: no log, no audit row, no UI signal. Debugging the
   * "0 facts saved despite a `for` loop calling remember" case
   * (chat 5f2690a6) required reading the exact codemode `error`
   * field, which `debug-chat.ts` was truncating at 300 chars.
   *
   * Now every reject:
   *   1. Emits a `memory.write_failed` Workers Logs event with a
   *      structured `reason` code (so saved searches can count
   *      "rejected by content_invalid this week").
   *   2. Writes a `memory.remember_rejected` audit row (best-effort
   *      via waitUntil). Audit DB is the durable record — zero-
   *      write debugging is one SQL query away.
   *   3. Broadcasts `data_agent_memory_write_rejected` so the live
   *      UI can render a one-line warn chip with a human reason.
   *      Live-only by design (no replay) — same constraint as
   *      MemoryChip.
   *   4. Throws the same wire shape as before so the model still
   *      sees the rejection and can adapt next turn.
   */
  // Explicit type annotation on the variable (not just the return
  // type on the arrow) so TS narrows control flow at every call
  // site — without it, `validated.display` and `args.kind` after a
  // reject look like they could still be `unknown`/`null`.
  const rejectRemember: (
    reason: string,
    code: string,
    kind: string,
    contentChars: number
  ) => never = (reason, code, kind, contentChars): never => {
    logEvent({
      event: "memory.write_failed",
      level: "warn",
      reason: code,
      kind,
      contentChars,
      tenantId: host.tenantId(),
      dbProfileId: host.dbProfileId(),
      chatId: host.chatId(),
      turnId: host.turnId(),
      message: reason,
    });
    // Audit + broadcast are both best-effort — neither should ever
    // mask the original reject from the model.
    try {
      host.audit("memory.remember_rejected", null, {
        reason: code,
        kind,
        contentChars,
      });
    } catch {
      // host.audit already swallows internally; this catch handles
      // the off-chance the host stub itself throws.
    }
    try {
      host.broadcast(
        JSON.stringify({
          type: "data_agent_memory_write_rejected",
          chatId: host.chatId(),
          reason: code,
          kind,
          contentChars,
        })
      );
    } catch {
      // No live conns / serialization edge — the audit row is the
      // durable record either way.
    }
    throw new Error(`memory.remember: ${reason}`);
  };

  const remember = async (
    rawArgs: unknown
  ): Promise<{ id: string; kind: string; content: string }> => {
    // Cheap entry-point heartbeat (task 996861). Counting attempts
    // vs. successes in Workers Logs is the fastest way to detect a
    // model that's spamming saves into a reject path. Also captures
    // the kind+contentChars *before* validation so we can see what
    // the model was trying to save even when it gets rejected.
    const kindArg =
      typeof (rawArgs as { kind?: unknown } | null)?.kind === "string"
        ? (rawArgs as { kind: string }).kind
        : "(non-string)";
    const contentChars =
      typeof (rawArgs as { content?: unknown } | null)?.content === "string"
        ? (rawArgs as { content: string }).content.length
        : -1;
    logEvent({
      event: "memory.write_attempt",
      level: "debug",
      chatId: host.chatId(),
      turnId: host.turnId(),
      kindArg,
      contentChars,
    });

    const tenantId = host.tenantId();
    const dbProfileId = host.dbProfileId();
    if (!tenantId || !dbProfileId) {
      rejectRemember(
        "chat has no attached database",
        "tenant_or_profile_missing",
        kindArg,
        contentChars
      );
    }
    const used = host.bumpRememberCount();
    if (used > REMEMBER_CALLS_PER_TURN) {
      rejectRemember(
        `per-turn cap reached (${REMEMBER_CALLS_PER_TURN} saves max). Save the most important facts only.`,
        "per_turn_cap_reached",
        kindArg,
        contentChars
      );
    }

    if (!rawArgs || typeof rawArgs !== "object") {
      rejectRemember(
        "{ kind, content, payload? } — args object required",
        "args_not_object",
        kindArg,
        contentChars
      );
    }
    const args = rawArgs as { kind?: unknown; content?: unknown; payload?: unknown };
    if (!isMemoryKind(args.kind)) {
      rejectRemember(
        `unknown kind "${String(args.kind)}". Allowed: schema_semantic | business_def | user_pref | query_pattern_good | query_pattern_bad | entity`,
        "unknown_kind",
        kindArg,
        contentChars
      );
    }
    if (args.kind === "chat_summary") {
      // chat_summary is reserved for the post-turn summarizer — the
      // model shouldn't manufacture them.
      rejectRemember(
        "chat_summary is reserved for the system",
        "reserved_kind",
        "chat_summary",
        contentChars
      );
    }
    const validated = validateMemoryContent(args.content);
    if (!validated.ok) {
      rejectRemember(
        validated.reason,
        "content_invalid",
        // narrowed by isMemoryKind above; rejectRemember above is `never`
        args.kind as string,
        contentChars
      );
    }

    const payload =
      args.payload && typeof args.payload === "object"
        ? (args.payload as Record<string, unknown>)
        : null;

    const persistResult = await persistFact(env, {
      tenantId,
      dbProfileId,
      kind: args.kind,
      content: validated.display,
      payload,
      sourceChatId: host.chatId(),
      sourceTurnId: host.turnId(),
      createdBy: host.userId(),
    });
    if (!persistResult.ok) {
      throw new Error(
        `memory.remember: per-database fact cap reached (${persistResult.cap}). Use memory.forget on outdated facts before saving new ones.`
      );
    }

    // Embed + Vectorize upsert iff this is a fresh insert. On
    // dedupe-update we leave the existing vector in place — the
    // content didn't change.
    if (persistResult.inserted || persistResult.revivedFromSoftDelete) {
      try {
        const vector = await embedText(env, validated.display);
        await upsertVector(env, {
          id: persistResult.row.id,
          values: vector,
          tenantId,
          metadata: {
            dbProfileId,
            kind: args.kind,
            createdAt: persistResult.row.createdAt.toISOString(),
          },
        });
      } catch (err) {
        // Roll back the Postgres row so Postgres + Vectorize don't
        // drift. The caller (codemode wrapper) will surface the
        // error to the model; it can retry next turn.
        logEvent({
          event: "memory.write_failed",
          level: "warn",
          factId: persistResult.row.id,
          reason: "embed_or_upsert_failed",
          kind: args.kind,
          contentChars: validated.display.length,
          tenantId,
          dbProfileId,
          chatId: host.chatId(),
          turnId: host.turnId(),
          error: truncateMessage(err),
        });
        host.waitUntil(
          softDeleteFact(env, {
            tenantId,
            dbProfileId,
            idOrHash: { kind: "id", value: persistResult.row.id },
          }).catch(() => {})
        );
        throw new Error(
          "memory.remember: failed to index the fact (the save did not stick — try again next turn)."
        );
      }
    }

    logEvent({
      event: "memory.write",
      level: "info",
      factId: persistResult.row.id,
      kind: args.kind,
      tenantId,
      dbProfileId,
      chatId: host.chatId(),
      turnId: host.turnId(),
      inserted: persistResult.inserted,
      revivedFromSoftDelete: persistResult.revivedFromSoftDelete,
    });

    // Broadcast so the UI renders the "Remembered: ..." chip.
    try {
      host.broadcast(
        JSON.stringify({
          type: "data_agent_memory_written",
          chatId: host.chatId(),
          fact: toView(persistResult.row) satisfies MemoryFactView,
          inserted: persistResult.inserted,
        })
      );
    } catch {
      // No live conns or serialization edge — the next page load
      // will pull from REST anyway.
    }

    host.audit("memory.remember", persistResult.row.id, {
      kind: args.kind,
      inserted: persistResult.inserted,
      revivedFromSoftDelete: persistResult.revivedFromSoftDelete,
      contentChars: validated.display.length,
    });

    return {
      id: persistResult.row.id,
      kind: persistResult.row.kind,
      content: persistResult.row.content,
    };
  };

  /**
   * Lighter sibling of `rejectRemember` for forget/search (task
   * 996861). The other reject paths in those two ops are user-input
   * shaped (empty string etc.) and noisy — only the
   * `tenant_or_profile_missing` case is interesting enough to log.
   * No audit + no broadcast: the model rejection alone is enough,
   * the audit row already exists for the tool call itself.
   */
  const logScopeMissing = (op: "forget" | "search"): void => {
    logEvent({
      event: "memory.write_failed",
      level: "warn",
      reason: "tenant_or_profile_missing",
      op,
      chatId: host.chatId(),
      turnId: host.turnId(),
    });
  };

  const forget = async (rawIdOrContent: unknown): Promise<{ id: string; ok: true }> => {
    const tenantId = host.tenantId();
    const dbProfileId = host.dbProfileId();
    if (!tenantId || !dbProfileId) {
      logScopeMissing("forget");
      throw new Error("memory.forget: chat has no attached database");
    }
    if (typeof rawIdOrContent !== "string" || !rawIdOrContent.trim()) {
      throw new Error("memory.forget(idOrContent) — non-empty string required");
    }
    const value = rawIdOrContent.trim();
    // UUID-ish detection: 36 chars with hyphens at standard positions.
    const looksLikeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    );
    const deleted = await softDeleteFact(env, {
      tenantId,
      dbProfileId,
      idOrHash: looksLikeId ? { kind: "id", value } : { kind: "content", value },
    });
    if (!deleted) {
      // No throw — forgetting a non-existent fact is not an error.
      // Return a result that signals to the model that nothing
      // changed; it can decide whether to follow up.
      return { id: "", ok: true };
    }
    host.waitUntil(deleteVectors(env, { ids: [deleted.id], tenantId }));
    host.audit("memory.forget", deleted.id, { source: "model" });
    logEvent({
      event: "memory.forget",
      level: "info",
      factId: deleted.id,
      tenantId,
      dbProfileId,
      chatId: host.chatId(),
      turnId: host.turnId(),
    });
    return { id: deleted.id, ok: true };
  };

  const search = async (
    rawQuery: unknown,
    rawOpts: unknown
  ): Promise<Array<{ id: string; kind: string; content: string; score: number }>> => {
    const tenantId = host.tenantId();
    const dbProfileId = host.dbProfileId();
    if (!tenantId || !dbProfileId) {
      logScopeMissing("search");
      throw new Error("memory.search: chat has no attached database");
    }
    if (typeof rawQuery !== "string" || !rawQuery.trim()) {
      throw new Error("memory.search(query, opts?) — non-empty string required");
    }
    const opts = (rawOpts ?? {}) as { topK?: unknown; kind?: unknown };
    const topK = Math.min(Math.max(typeof opts.topK === "number" ? opts.topK : 6, 1), 20);
    const kind: MemoryKind | undefined = isMemoryKind(opts.kind) ? opts.kind : undefined;

    const vector = await embedTextOrNull(env, rawQuery.trim());
    if (!vector) return [];
    const queryArgs: Parameters<typeof queryVectors>[1] = {
      vector,
      tenantId,
      dbProfileId,
      topK,
    };
    if (kind) queryArgs.kind = kind;
    const hits = await queryVectors(env, queryArgs);
    if (hits.length === 0) return [];

    const rows = await hydrateFacts(env, {
      tenantId,
      dbProfileId,
      ids: hits.map((h) => h.id),
    });
    const scoreById = new Map(hits.map((h) => [h.id, h.score]));
    return rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        score: scoreById.get(r.id) ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
  };

  return {
    name: "memory",
    types: TYPES,
    positionalArgs: true,
    tools: {
      remember: {
        description:
          "Save a durable fact about this database for future chats. Idempotent on (kind+content).",
        execute: async (...args: unknown[]) => remember(args[0]),
      },
      forget: {
        description: "Soft-delete a saved fact by id or content. Idempotent.",
        execute: async (...args: unknown[]) => forget(args[0]),
      },
      search: {
        description:
          "Semantic search across this database's saved memory. Useful when system-prompt recall didn't surface what you need.",
        execute: async (...args: unknown[]) => search(args[0], args[1]),
      },
    },
  };
}
