/**
 * Coverage for `memoryTools` reject paths (task 996861).
 *
 * The bug under test: zero-`memory.remember`-rows on a chat where the
 * model very obviously called the tool. Root cause was every reject
 * path being a bare `throw new Error(...)` — codemode's wrapper
 * caught it, the model saw `{error, recoverable: true}`, and we got
 * no log, no audit row, no UI signal. These tests lock in the new
 * `rejectRemember` behavior: every reject emits both a
 * `memory.write_failed` log AND a `memory.remember_rejected` audit
 * row, plus a `data_agent_memory_write_rejected` broadcast.
 *
 * We mock store/vectorize/embed because the success-path tests live
 * in `spike-memory.ts` (integration); this file is purely about the
 * reject-fanout shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logEventSpy = vi.fn();

vi.mock("@data-agent/shared", async () => {
  const actual = await vi.importActual<typeof import("@data-agent/shared")>("@data-agent/shared");
  return {
    ...actual,
    logEvent: (...args: unknown[]) => logEventSpy(...args),
  };
});

// Store/vectorize/embed should NEVER be reached on a reject path —
// if a test ends up calling them the assertions below will fail
// (mocks aren't installed). That's the point: the reject helper is
// the early-return gate.
vi.mock("./store", () => ({
  persistFact: vi.fn(async () => {
    throw new Error("persistFact should not be called on a reject path");
  }),
  softDeleteFact: vi.fn(async () => null),
  hydrateFacts: vi.fn(async () => []),
  toView: vi.fn(),
}));
vi.mock("./vectorize", () => ({
  upsertVector: vi.fn(async () => {}),
  deleteVectors: vi.fn(async () => {}),
  queryVectors: vi.fn(async () => []),
}));
vi.mock("./embed", () => ({
  embedText: vi.fn(async () => {
    throw new Error("embedText should not be called on a reject path");
  }),
  embedTextOrNull: vi.fn(async () => null),
}));

import { memoryTools, REMEMBER_CALLS_PER_TURN, type MemoryToolHost } from "./tools";

const fakeEnv = {} as never;

interface AuditRecord {
  action: string;
  target: string | null;
  payload: Record<string, unknown> | null;
}

function makeHost(opts: { tenantId?: string | null; dbProfileId?: string | null } = {}): {
  host: MemoryToolHost;
  audits: AuditRecord[];
  broadcasts: string[];
  rememberCount: { value: number };
} {
  const audits: AuditRecord[] = [];
  const broadcasts: string[] = [];
  const rememberCount = { value: 0 };
  const host: MemoryToolHost = {
    tenantId: () => (opts.tenantId === undefined ? "tenant_a" : opts.tenantId),
    dbProfileId: () => (opts.dbProfileId === undefined ? "profile_a" : opts.dbProfileId),
    userId: () => "user_a",
    chatId: () => "chat_a",
    turnId: () => "turn_a",
    bumpRememberCount: () => ++rememberCount.value,
    waitUntil: () => {},
    broadcast: (json: string) => {
      broadcasts.push(json);
    },
    audit: (action: string, target: string | null, payload: Record<string, unknown> | null) => {
      audits.push({ action, target, payload });
    },
  };
  return { host, audits, broadcasts, rememberCount };
}

async function callRemember(
  host: MemoryToolHost,
  args: unknown
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  // memoryTools returns a ToolProvider whose `tools.remember.execute`
  // is what codemode calls. Mirror that path so we exercise the same
  // entry point as production.
  const provider = memoryTools(fakeEnv, host);
  if (!provider) throw new Error("expected memoryTools to return a provider");
  try {
    const value = await provider.tools.remember.execute(args);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

beforeEach(() => {
  logEventSpy.mockReset();
});

describe("memoryTools — provider gating", () => {
  it("returns null when no dbProfile is attached", () => {
    const { host } = makeHost({ dbProfileId: null });
    expect(memoryTools(fakeEnv, host)).toBeNull();
  });
  it("returns null when no tenant is resolved", () => {
    const { host } = makeHost({ tenantId: null });
    expect(memoryTools(fakeEnv, host)).toBeNull();
  });
});

describe("memoryTools.remember — write_attempt heartbeat", () => {
  it("emits a memory.write_attempt log on every entry, before validation", async () => {
    const { host } = makeHost();
    await callRemember(host, { kind: "schema_semantic", content: "x".repeat(20) });
    const attempts = logEventSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string }).event === "memory.write_attempt"
    );
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const ev = attempts[0]![0] as Record<string, unknown>;
    expect(ev.kindArg).toBe("schema_semantic");
    expect(ev.contentChars).toBe(20);
    expect(ev.chatId).toBe("chat_a");
    expect(ev.turnId).toBe("turn_a");
  });

  it("captures non-string kind and missing content (rejects yet still heartbeats)", async () => {
    const { host } = makeHost();
    await callRemember(host, { kind: 42, content: null });
    const attempt = logEventSpy.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === "memory.write_attempt"
    )?.[0] as Record<string, unknown> | undefined;
    expect(attempt).toBeDefined();
    expect(attempt!.kindArg).toBe("(non-string)");
    expect(attempt!.contentChars).toBe(-1);
  });
});

describe("memoryTools.remember — reject fan-out", () => {
  // For each reject, assert the same three things:
  //   1. log emits memory.write_failed with the right reason code
  //   2. audit row "memory.remember_rejected" lands with same code
  //   3. broadcast carries data_agent_memory_write_rejected
  //   4. throws to the model

  function assertRejected(
    record: { ok: true; value: unknown } | { ok: false; message: string },
    audits: AuditRecord[],
    broadcasts: string[],
    code: string,
    expectedKind: string
  ) {
    expect(record.ok).toBe(false);
    if (record.ok) return;
    expect(record.message).toMatch(/^memory\.remember:/);

    const failed = logEventSpy.mock.calls.find(
      (c) =>
        (c[0] as { event?: string }).event === "memory.write_failed" &&
        (c[0] as { reason?: string }).reason === code
    )?.[0] as Record<string, unknown> | undefined;
    expect(failed, `missing memory.write_failed log for ${code}`).toBeDefined();
    expect(failed!.kind).toBe(expectedKind);
    expect(failed!.message).toBeTypeOf("string");

    const audit = audits.find((a) => a.action === "memory.remember_rejected");
    expect(audit, `missing audit row for ${code}`).toBeDefined();
    expect(audit!.payload).toMatchObject({ reason: code, kind: expectedKind });

    const broadcast = broadcasts
      .map((b) => JSON.parse(b))
      .find((b: { type?: string }) => b.type === "data_agent_memory_write_rejected");
    expect(broadcast, `missing broadcast for ${code}`).toBeDefined();
    expect(broadcast).toMatchObject({ reason: code });
  }

  it("rejects when chat lost its dbProfile mid-turn (tenant_or_profile_missing)", async () => {
    // The provider gate `memoryTools()` short-circuits when scope is
    // missing at *build* time. The reject path inside `rememberFn`
    // covers the race where scope was present at build but null at
    // call time (e.g. db profile detached mid-turn). We simulate by
    // mutating the host between build and call.
    const { host, audits, broadcasts } = makeHost();
    let scopeStillThere = true;
    (host as { dbProfileId: () => string | null }).dbProfileId = () =>
      scopeStillThere ? "profile_a" : null;
    const provider = memoryTools(fakeEnv, host);
    expect(provider).not.toBeNull();
    scopeStillThere = false;
    let captured: { ok: true; value: unknown } | { ok: false; message: string };
    try {
      const value = await provider!.tools.remember.execute({
        kind: "schema_semantic",
        content: "hello world hello world",
      });
      captured = { ok: true, value };
    } catch (err) {
      captured = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    assertRejected(captured, audits, broadcasts, "tenant_or_profile_missing", "schema_semantic");
  });

  it("rejects on per-turn cap (per_turn_cap_reached)", async () => {
    const { host, audits, broadcasts, rememberCount } = makeHost();
    rememberCount.value = REMEMBER_CALLS_PER_TURN; // next bump → REMEMBER_CALLS_PER_TURN+1
    const r = await callRemember(host, {
      kind: "schema_semantic",
      content: "this is a fact long enough to pass content length checks",
    });
    assertRejected(r, audits, broadcasts, "per_turn_cap_reached", "schema_semantic");
  });

  it("rejects when args is not an object (args_not_object)", async () => {
    const { host, audits, broadcasts } = makeHost();
    const r = await callRemember(host, "definitely-not-an-object");
    // kindArg falls back to "(non-string)" because rawArgs has no
    // .kind to read.
    assertRejected(r, audits, broadcasts, "args_not_object", "(non-string)");
  });

  it("rejects on unknown kind (unknown_kind)", async () => {
    const { host, audits, broadcasts } = makeHost();
    const r = await callRemember(host, {
      kind: "totally_made_up",
      content: "this is a fact long enough to pass content length checks",
    });
    assertRejected(r, audits, broadcasts, "unknown_kind", "totally_made_up");
  });

  it("rejects on reserved kind chat_summary (reserved_kind)", async () => {
    const { host, audits, broadcasts } = makeHost();
    const r = await callRemember(host, {
      kind: "chat_summary",
      content: "this is a fact long enough to pass content length checks",
    });
    assertRejected(r, audits, broadcasts, "reserved_kind", "chat_summary");
  });

  it("rejects on too-short content (content_invalid)", async () => {
    const { host, audits, broadcasts } = makeHost();
    const r = await callRemember(host, { kind: "schema_semantic", content: "hi" });
    assertRejected(r, audits, broadcasts, "content_invalid", "schema_semantic");
  });

  it("rejects on too-long content (content_invalid) — locks in the 2000 ceiling", async () => {
    // Repro of the original bug shape: a 2001-char schema fact.
    const { host, audits, broadcasts } = makeHost();
    const r = await callRemember(host, {
      kind: "schema_semantic",
      content: "x".repeat(2001),
    });
    assertRejected(r, audits, broadcasts, "content_invalid", "schema_semantic");
  });
});
