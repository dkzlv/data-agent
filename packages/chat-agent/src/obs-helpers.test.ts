import { describe, expect, it } from "vitest";
import { countConnections, describeError } from "./obs-helpers";

describe("countConnections", () => {
  it("counts iterable yields", () => {
    const agent = {
      getConnections: () => [1, 2, 3][Symbol.iterator](),
    };
    expect(countConnections(agent)).toBe(3);
  });

  it("returns 0 for empty iterable", () => {
    const agent = { getConnections: () => [][Symbol.iterator]() };
    expect(countConnections(agent)).toBe(0);
  });
});

describe("describeError", () => {
  it("captures Error.name + message", () => {
    const err = new TypeError("boom");
    const info = describeError(err);
    expect(info.name).toBe("TypeError");
    expect(info.message).toBe("boom");
    expect(info.cause).toBeNull();
    expect(info.isAbort).toBe(false);
  });

  it("flags AbortError as abort", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(describeError(err).isAbort).toBe(true);
  });

  it('flags messages containing "aborted" as abort', () => {
    const err = new Error("the request was aborted by the user");
    expect(describeError(err).isAbort).toBe(true);
  });

  it('flags the specific "BodyStreamBuffer was aborted" message', () => {
    const err = new Error("BodyStreamBuffer was aborted");
    expect(describeError(err).isAbort).toBe(true);
  });

  it("does not flag unrelated messages as abort", () => {
    const err = new Error("connection refused");
    expect(describeError(err).isAbort).toBe(false);
  });

  it("walks one level of Error.cause", () => {
    const root = new Error("TLS handshake failed");
    root.name = "NetworkError";
    const wrapped = new Error("fetch failed", { cause: root });
    const info = describeError(wrapped);
    expect(info.cause).toBe("NetworkError: TLS handshake failed");
  });

  it("stringifies non-Error causes", () => {
    const wrapped = new Error("oops", { cause: "transport closed" });
    const info = describeError(wrapped);
    expect(info.cause).toBe("transport closed");
  });

  it("handles non-Error thrown values", () => {
    const info = describeError("string-thrown");
    expect(info.name).toBe("non-error");
    expect(info.message).toBe("string-thrown");
    expect(info.isAbort).toBe(false);
    expect(info.cause).toBeNull();
  });

  it("flags non-Error abort strings", () => {
    const info = describeError("operation aborted");
    expect(info.isAbort).toBe(true);
  });

  it("truncates very long messages to 500 chars", () => {
    const long = "x".repeat(1000);
    const info = describeError(new Error(long));
    expect(info.message.length).toBe(500);
  });

  it("uses 'Error' as the name when err.name is empty", () => {
    const err = new Error("y");
    err.name = "";
    expect(describeError(err).name).toBe("Error");
  });
});
