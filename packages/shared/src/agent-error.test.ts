import { describe, expect, it } from "vitest";
import { AGENT_ERROR_PREFIX, decodeAgentError, encodeAgentError } from "./agent-error";

describe("encodeAgentError / decodeAgentError", () => {
  it("round-trips a minimal payload", () => {
    const payload = { code: "rate_limit_chat_daily", message: "too many" };
    const wire = encodeAgentError(payload);
    expect(wire.startsWith(AGENT_ERROR_PREFIX)).toBe(true);
    const decoded = decodeAgentError(wire);
    expect(decoded).toEqual(payload);
  });

  it("preserves details across the round-trip", () => {
    const payload = {
      code: "sandbox_timeout",
      message: "tool ran too long",
      details: { tool: "db.query", limitMs: 30_000, elapsedMs: 31_120 },
    };
    const decoded = decodeAgentError(encodeAgentError(payload));
    expect(decoded?.details).toMatchObject(payload.details);
  });

  it("returns null for plain error messages", () => {
    expect(decodeAgentError("Something exploded")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(decodeAgentError(undefined)).toBeNull();
    expect(decodeAgentError(null)).toBeNull();
    expect(decodeAgentError(42)).toBeNull();
    expect(decodeAgentError({ code: "x", message: "y" })).toBeNull();
  });

  it("returns null when the prefix is present but the JSON tail is malformed", () => {
    expect(decodeAgentError(`${AGENT_ERROR_PREFIX}{not-json`)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(decodeAgentError(`${AGENT_ERROR_PREFIX}{}`)).toBeNull();
    expect(decodeAgentError(`${AGENT_ERROR_PREFIX}${JSON.stringify({ code: "x" })}`)).toBeNull();
    expect(decodeAgentError(`${AGENT_ERROR_PREFIX}${JSON.stringify({ message: "y" })}`)).toBeNull();
  });

  it("tolerates arbitrary shapes inside details (no schema enforcement)", () => {
    const payload = {
      code: "sql_timeout",
      message: "took too long",
      details: { nested: { deeply: { yes: true } }, arr: [1, 2, 3] },
    };
    const decoded = decodeAgentError(encodeAgentError(payload));
    expect(decoded?.details?.["nested"]).toEqual({ deeply: { yes: true } });
    expect(decoded?.details?.["arr"]).toEqual([1, 2, 3]);
  });
});
