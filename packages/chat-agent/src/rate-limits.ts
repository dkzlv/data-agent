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

export class RateLimitError extends Error {
  constructor(
    public readonly code: string,
    public readonly max: number,
    public readonly windowMs: number,
    public readonly current: number
  ) {
    super(`rate limit hit: ${code} (${current}/${max} in ${Math.round(windowMs / 60000)}min)`);
    this.name = "RateLimitError";
  }
}

/**
 * Check all configured windows in a single round trip. Returns the
 * first failure, or `{ ok: true }` if everything is within budget.
 */
export async function checkRateLimits(
  db: Database,
  scope: RateLimitScope
): Promise<RateLimitDecision> {
  const now = Date.now();

  // Build all the count queries. We could compose them into one CTE
  // for one-roundtrip semantics; keeping three small queries is
  // simpler and reads cleanly. They're indexed: audit_log_tenant_created_idx
  // covers tenant+created_at, and audit_log_chat_idx covers chatId.
  const policies: Array<{
    window: RateLimitWindow;
    scope: typeof scope;
    key: "chat" | "user" | "tenant";
  }> = [];

  if (scope.chatId) {
    policies.push({ window: DEFAULT_POLICY.perChatPerDay, scope, key: "chat" });
  }
  if (scope.userId) {
    policies.push({ window: DEFAULT_POLICY.perUserPerHour, scope, key: "user" });
  }
  policies.push({ window: DEFAULT_POLICY.perTenantPerDay, scope, key: "tenant" });

  for (const p of policies) {
    const since = new Date(now - p.window.windowMs);
    const conds = [
      eq(schema.auditLog.action, p.window.action),
      gte(schema.auditLog.createdAt, since),
    ];
    if (p.key === "chat" && p.scope.chatId) {
      conds.push(eq(schema.auditLog.chatId, p.scope.chatId));
    } else if (p.key === "user" && p.scope.userId) {
      conds.push(
        eq(schema.auditLog.tenantId, p.scope.tenantId),
        eq(schema.auditLog.userId, p.scope.userId)
      );
    } else if (p.key === "tenant") {
      conds.push(eq(schema.auditLog.tenantId, p.scope.tenantId));
    }

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.auditLog)
      .where(and(...conds));

    const current = row?.n ?? 0;
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
