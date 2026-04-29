import { describe, expect, it, vi, beforeEach } from "vitest";
import { TurnLogger, type EnvelopeProvider } from "./turn-logger";

// Mock @data-agent/shared.logEvent and ./audit.auditFromAgent
const logEventSpy = vi.fn();
const auditSpy = vi.fn();

vi.mock("@data-agent/shared", async () => {
  const actual = await vi.importActual<typeof import("@data-agent/shared")>("@data-agent/shared");
  return {
    ...actual,
    logEvent: (...args: unknown[]) => logEventSpy(...args),
  };
});

vi.mock("./audit", () => ({
  auditFromAgent: (...args: unknown[]) => auditSpy(...args),
}));

class StubProvider implements EnvelopeProvider {
  constructor(
    public chatId: string,
    public tenantId: string | null,
    public userId: string | null,
    public turnId: string | null
  ) {}
}

const fakeEnv = {} as never;

describe("TurnLogger.event", () => {
  beforeEach(() => {
    logEventSpy.mockReset();
    auditSpy.mockReset();
  });

  it("merges chatId/tenantId/userId/turnId into every event", () => {
    const provider = new StubProvider("chat_a", "tenant_b", "user_c", "t_xx");
    const log = new TurnLogger(fakeEnv, provider);
    log.event("chat.turn_start", { foo: "bar" });
    expect(logEventSpy).toHaveBeenCalledWith({
      event: "chat.turn_start",
      chatId: "chat_a",
      tenantId: "tenant_b",
      userId: "user_c",
      turnId: "t_xx",
      foo: "bar",
    });
  });

  it("includes level only when provided", () => {
    const provider = new StubProvider("c", null, null, null);
    const log = new TurnLogger(fakeEnv, provider);
    log.event("x");
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ level: expect.anything() })
    );
    log.event("y", { level: "warn" });
    expect(logEventSpy).toHaveBeenLastCalledWith(expect.objectContaining({ level: "warn" }));
  });

  it("folds in extras() output (e.g. connection counts)", () => {
    const provider = new StubProvider("c", null, null, null);
    let n = 0;
    const log = new TurnLogger(fakeEnv, provider, () => ({ connections: ++n }));
    log.event("a");
    log.event("b");
    expect(logEventSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ connections: 1 }));
    expect(logEventSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ connections: 2 }));
  });

  it("reads provider state lazily on each call (latest values win)", () => {
    const provider = new StubProvider("c", null, null, null);
    const log = new TurnLogger(fakeEnv, provider);

    log.event("e1");
    expect(logEventSpy).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: null }));

    provider.tenantId = "tenant_xyz";
    provider.userId = "u1";
    provider.turnId = "t_1";
    log.event("e2");
    expect(logEventSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: "tenant_xyz", userId: "u1", turnId: "t_1" })
    );
  });

  it("event-specific fields override envelope (unusual but explicit)", () => {
    const provider = new StubProvider("c", "t", null, null);
    const log = new TurnLogger(fakeEnv, provider);
    log.event("e", { tenantId: "override" });
    expect(logEventSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: "override" })
    );
  });
});

describe("TurnLogger.audit", () => {
  beforeEach(() => {
    logEventSpy.mockReset();
    auditSpy.mockReset();
    auditSpy.mockResolvedValue(undefined);
  });

  it("returns null + skips when tenantId is null", () => {
    const provider = new StubProvider("c", null, null, null);
    const log = new TurnLogger(fakeEnv, provider);
    const result = log.audit("turn.start", "target_x", { foo: 1 });
    expect(result).toBeNull();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("forwards tenant/chat/user envelope to auditFromAgent", () => {
    const provider = new StubProvider("c", "t", "u", "tid");
    const log = new TurnLogger(fakeEnv, provider);
    log.audit("turn.start", "tgt", { ok: true });
    expect(auditSpy).toHaveBeenCalledWith(fakeEnv, {
      tenantId: "t",
      chatId: "c",
      userId: "u",
      action: "turn.start",
      target: "tgt",
      payload: { ok: true },
    });
  });

  it("supports a userOverride for system-driven audit rows", () => {
    const provider = new StubProvider("c", "t", "u_real", null);
    const log = new TurnLogger(fakeEnv, provider);
    log.audit("turn.start", null, null, "u_other");
    expect(auditSpy).toHaveBeenCalledWith(
      fakeEnv,
      expect.objectContaining({ userId: "u_other" })
    );
  });

  it("preserves null user when override is explicitly null", () => {
    const provider = new StubProvider("c", "t", "u_real", null);
    const log = new TurnLogger(fakeEnv, provider);
    log.audit("turn.start", null, null, null);
    expect(auditSpy).toHaveBeenCalledWith(
      fakeEnv,
      expect.objectContaining({ userId: null })
    );
  });
});
