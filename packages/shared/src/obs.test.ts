import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logEvent, truncateMessage, withSpan } from "./obs";

describe("logEvent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits a JSON line via console.log for info level (default)", () => {
    logEvent({ event: "api.request", path: "/health" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.event).toBe("api.request");
    expect(parsed.path).toBe("/health");
    expect(parsed.level).toBe("info");
    // ts is a parseable ISO 8601
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });

  it("routes by level: debug/warn/error use the matching console method", () => {
    logEvent({ event: "x", level: "debug" });
    logEvent({ event: "x", level: "warn" });
    logEvent({ event: "x", level: "error" });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("falls back gracefully on circular references", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    logEvent({ event: "weird", payload: a });
    expect(warnSpy).toHaveBeenCalled();
    const arg = warnSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.event).toBe("weird");
    expect(parsed.note).toBe("log_payload_unserializable");
  });
});

describe("withSpan", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("logs ok + durationMs on success and returns the value", async () => {
    const result = await withSpan("chat.turn", { chatId: "c1" }, async () => 42);
    expect(result).toBe(42);
    const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(parsed.event).toBe("chat.turn");
    expect(parsed.chatId).toBe("c1");
    expect(parsed.status).toBe("ok");
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs error + durationMs and re-throws on failure", async () => {
    await expect(
      withSpan("chat.turn", { chatId: "c2" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const parsed = JSON.parse(errorSpy.mock.calls[0]![0] as string);
    expect(parsed.event).toBe("chat.turn");
    expect(parsed.status).toBe("error");
    expect(parsed.error).toContain("boom");
  });
});

describe("truncateMessage", () => {
  it("returns full message under threshold", () => {
    expect(truncateMessage("short")).toBe("short");
  });
  it("appends ellipsis when over threshold", () => {
    const long = "x".repeat(300);
    const out = truncateMessage(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(241);
  });
  it("handles non-Error inputs", () => {
    expect(truncateMessage(42)).toBe("42");
    expect(truncateMessage(null)).toBe("null");
  });
});
