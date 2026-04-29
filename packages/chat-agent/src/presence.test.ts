import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  attachConnection,
  buildPresencePayload,
  currentUserIdFromConnection,
  detachConnection,
  type PresenceState,
} from "./presence";
import { TurnState } from "./turn-state";

const logEventSpy = vi.fn();
vi.mock("@data-agent/shared", async () => {
  const actual = await vi.importActual<typeof import("@data-agent/shared")>("@data-agent/shared");
  return {
    ...actual,
    logEvent: (...args: unknown[]) => logEventSpy(...args),
  };
});

beforeEach(() => {
  logEventSpy.mockReset();
});

describe("buildPresencePayload", () => {
  it("dedupes by userId and keeps earliest joinedAt", () => {
    const conns = [
      { state: { userId: "u1", joinedAt: 100 } },
      { state: { userId: "u1", joinedAt: 50 } },
      { state: { userId: "u2", joinedAt: 200 } },
      { state: null },
    ];
    const json = buildPresencePayload(conns);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("data_agent_presence");
    expect(parsed.users).toEqual([
      { userId: "u1", joinedAt: 50 },
      { userId: "u2", joinedAt: 200 },
    ]);
  });

  it("ignores connections without state", () => {
    const conns = [{ state: undefined }, { state: null }];
    const parsed = JSON.parse(buildPresencePayload(conns));
    expect(parsed.users).toEqual([]);
  });
});

describe("attachConnection", () => {
  it("stamps state and logs chat.ws.connect", () => {
    const setState = vi.fn();
    const connection = { id: "c1", setState } as never;
    const ctx = {
      request: {
        headers: new Headers({
          "x-data-agent-user-id": "u_a",
          "x-data-agent-tenant-id": "t_a",
        }),
      },
    } as never;
    attachConnection(connection, ctx, { chatId: "chat", activeConnections: 2 });
    expect(setState).toHaveBeenCalledTimes(1);
    const stamped = setState.mock.calls[0]?.[0] as PresenceState;
    expect(stamped.userId).toBe("u_a");
    expect(stamped.tenantId).toBe("t_a");
    expect(stamped.joinedAt).toBeGreaterThan(0);
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.ws.connect",
        chatId: "chat",
        userId: "u_a",
        tenantId: "t_a",
        activeConnections: 2,
      })
    );
  });

  it("falls back to anonymous when headers missing", () => {
    const connection = { id: "c1", setState: vi.fn() } as never;
    const ctx = { request: { headers: new Headers() } } as never;
    attachConnection(connection, ctx, { chatId: "chat", activeConnections: 1 });
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "anonymous", tenantId: "" })
    );
  });
});

describe("detachConnection", () => {
  it("logs chat.ws.close with turn snapshot fields", () => {
    const turn = new TurnState();
    turn.start("u1");
    const connection = {
      id: "c1",
      state: { userId: "u_a", tenantId: "t_a", joinedAt: Date.now() - 1000 },
    } as never;
    detachConnection(connection, {
      chatId: "chat",
      code: 1006,
      reason: "abnormal",
      wasClean: false,
      turn,
      remainingConnections: 0,
    });
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.ws.close",
        level: "warn",
        chatId: "chat",
        code: 1006,
        userId: "u_a",
        wasClean: false,
        activeTurnId: turn.turnId,
        remainingConnections: 0,
      })
    );
  });

  it("uses level=info on clean close", () => {
    const turn = new TurnState();
    const connection = { id: "c1", state: null } as never;
    detachConnection(connection, {
      chatId: "chat",
      code: 1000,
      reason: "",
      wasClean: true,
      turn,
      remainingConnections: 1,
    });
    expect(logEventSpy).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
  });
});

describe("currentUserIdFromConnection", () => {
  it("reads userId off state", () => {
    expect(currentUserIdFromConnection({ state: { userId: "u_a", joinedAt: 1 } } as never)).toBe(
      "u_a"
    );
    expect(currentUserIdFromConnection({ state: null } as never)).toBeUndefined();
  });
});
