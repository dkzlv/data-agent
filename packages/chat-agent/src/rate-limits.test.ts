import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  RateLimitError,
  evaluatePolicy,
  type RateLimitWindow,
  type RateLimitScope,
} from "./rate-limits";

/** Build a stubbed count function from a per-key event-count map. */
function counter(
  counts: Partial<Record<"chat" | "user" | "tenant", number>>
): (
  key: "chat" | "user" | "tenant",
  window: RateLimitWindow,
  scope: RateLimitScope
) => Promise<number> {
  return async (key) => counts[key] ?? 0;
}

const SCOPE: RateLimitScope = {
  tenantId: "t1",
  userId: "u1",
  chatId: "c1",
};

describe("evaluatePolicy", () => {
  it("returns ok when all counters are below budget", async () => {
    const r = await evaluatePolicy(SCOPE, counter({ chat: 5, user: 3, tenant: 10 }));
    expect(r.ok).toBe(true);
  });

  it("rejects when chat counter is at the daily cap", async () => {
    const r = await evaluatePolicy(SCOPE, counter({ chat: 50 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("rate_limit_chat_daily");
    expect(r.current).toBe(50);
    expect(r.max).toBe(50);
  });

  it("rejects when user counter is at the hourly cap", async () => {
    // user check fires before tenant; chat is 0 so it's well under.
    const r = await evaluatePolicy(SCOPE, counter({ user: 20 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("rate_limit_user_hourly");
  });

  it("rejects when tenant counter is at the tenant cap", async () => {
    const r = await evaluatePolicy(SCOPE, counter({ tenant: 200 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("rate_limit_tenant_daily");
  });

  it("short-circuits on the first violation in policy order", async () => {
    // All three over limit — chat is checked first, so chat wins.
    const r = await evaluatePolicy(SCOPE, counter({ chat: 60, user: 30, tenant: 250 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("rate_limit_chat_daily");
  });

  it("skips chat policy when chatId is missing", async () => {
    // No chatId → chat policy doesn't run; high chat count is irrelevant.
    const r = await evaluatePolicy(
      { tenantId: "t1", userId: "u1" },
      counter({ chat: 9999, tenant: 5 })
    );
    expect(r.ok).toBe(true);
  });

  it("skips user policy when userId is missing", async () => {
    const r = await evaluatePolicy(
      { tenantId: "t1", chatId: "c1" },
      counter({ chat: 5, user: 9999, tenant: 5 })
    );
    expect(r.ok).toBe(true);
  });

  it("always evaluates the tenant policy even with no chatId/userId", async () => {
    const r = await evaluatePolicy({ tenantId: "t1" }, counter({ tenant: 200 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("rate_limit_tenant_daily");
  });

  it("treats N >= max as over (not strict greater-than)", async () => {
    // Chat cap is 50; exactly 50 should be rejected because adding the
    // *current* turn would make it 51.
    const r = await evaluatePolicy(SCOPE, counter({ chat: 50 }));
    expect(r.ok).toBe(false);
  });

  it("allows N = max - 1 (room for one more turn)", async () => {
    const r = await evaluatePolicy(SCOPE, counter({ chat: 49, user: 19, tenant: 199 }));
    expect(r.ok).toBe(true);
  });

  it("respects a custom policy override", async () => {
    const tightPolicy = {
      perChatPerDay: { ...DEFAULT_POLICY.perChatPerDay, max: 2 },
      perUserPerHour: { ...DEFAULT_POLICY.perUserPerHour, max: 5 },
      perTenantPerDay: { ...DEFAULT_POLICY.perTenantPerDay, max: 10 },
    };
    const r = await evaluatePolicy(SCOPE, counter({ chat: 2 }), tightPolicy);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.max).toBe(2);
  });

  it("passes the scope through to the count function", async () => {
    const seen: Array<{ key: string; scope: RateLimitScope }> = [];
    await evaluatePolicy(SCOPE, async (key, _w, s) => {
      seen.push({ key, scope: s });
      return 0;
    });
    expect(seen.map((s) => s.key)).toEqual(["chat", "user", "tenant"]);
    for (const entry of seen) {
      expect(entry.scope.tenantId).toBe("t1");
    }
  });
});

describe("DEFAULT_POLICY constants", () => {
  it("uses the action 'turn.start' so it counts the audit_log row from beforeTurn", () => {
    expect(DEFAULT_POLICY.perChatPerDay.action).toBe("turn.start");
    expect(DEFAULT_POLICY.perUserPerHour.action).toBe("turn.start");
    expect(DEFAULT_POLICY.perTenantPerDay.action).toBe("turn.start");
  });

  it("has progressively wider tenant > chat > user windows for the right shape", () => {
    expect(DEFAULT_POLICY.perChatPerDay.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_POLICY.perTenantPerDay.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_POLICY.perUserPerHour.windowMs).toBe(60 * 60 * 1000);
  });

  it("tenant cap is higher than chat + user caps", () => {
    expect(DEFAULT_POLICY.perTenantPerDay.max).toBeGreaterThan(DEFAULT_POLICY.perChatPerDay.max);
    expect(DEFAULT_POLICY.perTenantPerDay.max).toBeGreaterThan(DEFAULT_POLICY.perUserPerHour.max);
  });

  it("uses stable error codes prefixed with rate_limit_", () => {
    expect(DEFAULT_POLICY.perChatPerDay.code).toMatch(/^rate_limit_/);
    expect(DEFAULT_POLICY.perUserPerHour.code).toMatch(/^rate_limit_/);
    expect(DEFAULT_POLICY.perTenantPerDay.code).toMatch(/^rate_limit_/);
  });
});

describe("RateLimitError", () => {
  it("captures all dimensions of the failure", () => {
    const err = new RateLimitError("rate_limit_chat_daily", 50, 86_400_000, 50);
    expect(err.name).toBe("RateLimitError");
    expect(err.code).toBe("rate_limit_chat_daily");
    expect(err.max).toBe(50);
    expect(err.windowMs).toBe(86_400_000);
    expect(err.current).toBe(50);
  });

  it("encodes a structured agent-error envelope as the .message", () => {
    const err = new RateLimitError("rate_limit_chat_daily", 50, 86_400_000, 50);
    expect(err.message.startsWith("DATA_AGENT_ERROR\n")).toBe(true);
    const json = err.message.split("\n", 2)[1]!;
    const parsed = JSON.parse(json);
    expect(parsed.code).toBe("rate_limit_chat_daily");
    expect(parsed.message).toContain("rate_limit_chat_daily");
    expect(parsed.message).toContain("50/50");
    expect(parsed.details).toMatchObject({
      max: 50,
      windowMs: 86_400_000,
      current: 50,
    });
    expect(typeof parsed.details.retryAt).toBe("string");
    // ISO 8601 sanity
    expect(Number.isFinite(Date.parse(parsed.details.retryAt))).toBe(true);
  });

  it("formats the window in minutes inside the inner message", () => {
    const err = new RateLimitError("rate_limit_user_hourly", 20, 60 * 60 * 1000, 20);
    const inner = JSON.parse(err.message.split("\n", 2)[1]!);
    expect(inner.message).toContain("60min");
  });
});
