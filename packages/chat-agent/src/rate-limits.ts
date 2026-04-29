/**
 * Rate-limit checks for chat turns (subtask d7943e/947c38).
 *
 * Hard caps enforced before every LLM turn:
 *
 *   - 50 turns/chat/day        (per CHAT, rolling 24h)
 *   - 20 turns/user/hour       (per USER, rolling 60min)
 *   - 200 turns/tenant/day     (per TENANT, rolling 24h, anti-abuse)
 *
 * Implementation: count `turn.start` rows in `audit_log` within the
 * window. We already write one row per turn (subtask 1dd311) so the
 * counter is "free" — no new table, no separate counter store, no
 * cross-DO state to keep consistent.
 *
 * Trade-off: counts include the *current* turn only after `beforeTurn`
 * has written its audit row. We fix this by counting **strictly before
 * the current turn**: the audit write for turn-N runs in the same
 * `beforeTurn` hook as the rate check, but we sequence the check
 * *before* the audit insert so turn-N is allowed if turns 0..N-1 are
 * within budget.
 *
 * On limit hit we throw a `RateLimitError` with a stable code; Think's
 * `onChatError` surfaces it to the client and writes a `turn.error`
 * audit row with `code=rate_limit`. The user-visible error UX is
 * handled in subtask 2f89ff.
 */
import type { Database } from "@data-agent/db";
import { schema } from "@data-agent/db";
import { and, eq, gte, sql } from "drizzle-orm";

export type RateLimitWindow = {
  /** ISO action prefix to count, e.g. `"turn.start"`. */
  action: string;
  /** Window in milliseconds. */
  windowMs: number;
  /** Max events allowed in the window. */
  max: number;
  /** Stable error code surfaced to the client. */
  code: string;
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; code: string; max: number; windowMs: number; current: number };

export type RateLimitScope = {
  tenantId: string;
  userId?: string | null;
  chatId?: string | null;
};

/**
 * Default policy. Tweak per-environment via env vars in a future
 * subtask — for now a literal so the contract is obvious.
 */
export const DEFAULT_POLICY = {
  perChatPerDay: {
    action: "turn.start",
    windowMs: 24 * 60 * 60 * 1000,
    max: 50,
    code: "rate_limit_chat_daily",
  },
  perUserPerHour: {
    action: "turn.start",
    windowMs: 60 * 60 * 1000,
    max: 20,
    code: "rate_limit_user_hourly",
  },
  perTenantPerDay: {
    action: "turn.start",
    windowMs: 24 * 60 * 60 * 1000,
    max: 200,
    code: "rate_limit_tenant_daily",
  },
} as const;

// Import from shared so the web client decodes against the same
// canonical envelope shape (subtask 2f89ff). The encoder/prefix live
// in `@data-agent/shared/agent-error`.
import { encodeAgentError } from "@data-agent/shared";

export class RateLimitError extends Error {
  constructor(
    public readonly code: string,
    public readonly max: number,
    public readonly windowMs: number,
    public readonly current: number
  ) {
    // Keep `.message` as a structured envelope so the web client can
    // render a precise banner (e.g. "Daily chat cap reached — resets
    // at 12:00 UTC") instead of a generic "connection error".
    super(
      encodeAgentError({
        code,
        message: `rate limit hit: ${code} (${current}/${max} in ${Math.round(windowMs / 60000)}min)`,
        details: {
          max,
          windowMs,
          current,
          // Earliest retry time, computed conservatively as
          // (now + remainingWindow). For a sliding 24h window this is
          // wrong (the oldest event might age out sooner), but
          // erring later keeps us from advertising a too-optimistic
          // retry — better UX than the user retrying immediately
          // and hitting the limit again.
          retryAt: new Date(Date.now() + windowMs).toISOString(),
        },
      })
    );
    this.name = "RateLimitError";
  }
}

/**
 * Pure policy-evaluator. Walks each configured window and queries the
 * provided count function for the number of matching events. The
 * first window over budget short-circuits and returns the failure.
 *
 * Split from `checkRateLimits` so we can unit-test the policy logic
 * without a Postgres connection — the test injects a stubbed
 * `countEvents`.
 */
export async function evaluatePolicy(
  scope: RateLimitScope,
  countEvents: (
    key: "chat" | "user" | "tenant",
    window: RateLimitWindow,
    scope: RateLimitScope
  ) => Promise<number>,
  policy: {
    perChatPerDay: RateLimitWindow;
    perUserPerHour: RateLimitWindow;
    perTenantPerDay: RateLimitWindow;
  } = DEFAULT_POLICY
): Promise<RateLimitDecision> {
  const policies: Array<{
    window: RateLimitWindow;
    key: "chat" | "user" | "tenant";
  }> = [];

  if (scope.chatId) policies.push({ window: policy.perChatPerDay, key: "chat" });
  if (scope.userId) policies.push({ window: policy.perUserPerHour, key: "user" });
  policies.push({ window: policy.perTenantPerDay, key: "tenant" });

  for (const p of policies) {
    const current = await countEvents(p.key, p.window, scope);
    if (current >= p.window.max) {
      return {
        ok: false,
        code: p.window.code,
        max: p.window.max,
        windowMs: p.window.windowMs,
        current,
      };
    }
  }

  return { ok: true };
}

/**
 * Driver: open a max=1 control-plane connection, run the rate-limit
 * check against the live `audit_log` table, close the connection in
 * the background via the caller's `waitUntil`.
 *
 * Lives here (not in agent.ts) so the connection lifecycle stays next
 * to the policy that uses it. Caller passes `waitUntil` so a slow
 * close doesn't block the calling hook.
 */
export interface RateLimitDriverInputs {
  env: { CONTROL_PLANE_DB_URL: unknown };
  chatId: string;
  tenantId: string;
  userId: string | null;
  /** waitUntil-compatible callback. */
  waitUntil: (p: Promise<unknown>) => void;
}

export async function runRateLimitCheck(inputs: RateLimitDriverInputs): Promise<RateLimitDecision> {
  const { createDbClient } = await import("@data-agent/db");
  // Local import to avoid a top-level dependency on env.ts (the
  // module is otherwise pure-policy + Database-typed).
  const { readSecret } = await import("./env");
  const url = await readSecret(inputs.env.CONTROL_PLANE_DB_URL as never);
  const { db, client } = createDbClient({ url, max: 1 });
  try {
    return await checkRateLimits(db, {
      tenantId: inputs.tenantId,
      userId: inputs.userId,
      chatId: inputs.chatId,
    });
  } finally {
    inputs.waitUntil(client.end({ timeout: 1 }).catch(() => {}));
  }
}

/**
 * Check all configured windows against the live `audit_log` table.
 * Returns the first failure, or `{ ok: true }` if everything is within
 * budget. Three small queries (indexed by `audit_log_tenant_created_idx`
 * / `audit_log_chat_idx`) instead of one CTE because the readability
 * is worth more than the round-trip; we may revisit if pg latency
 * becomes a hot path.
 */
export async function checkRateLimits(
  db: Database,
  scope: RateLimitScope
): Promise<RateLimitDecision> {
  return evaluatePolicy(scope, async (key, window, s) => {
    const since = new Date(Date.now() - window.windowMs);
    const conds = [
      eq(schema.auditLog.action, window.action),
      gte(schema.auditLog.createdAt, since),
    ];
    if (key === "chat" && s.chatId) {
      conds.push(eq(schema.auditLog.chatId, s.chatId));
    } else if (key === "user" && s.userId) {
      conds.push(eq(schema.auditLog.tenantId, s.tenantId), eq(schema.auditLog.userId, s.userId));
    } else if (key === "tenant") {
      conds.push(eq(schema.auditLog.tenantId, s.tenantId));
    }
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(and(...conds));
    return row?.n ?? 0;
  });
}
