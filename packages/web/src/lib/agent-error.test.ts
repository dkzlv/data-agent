import { describe, expect, it } from "vitest";
import { encodeAgentError } from "@data-agent/shared";
import { shouldClearStaleError } from "./agent-error";

/**
 * shouldClearStaleError encodes the rule that survived chat
 * `3a76a225` (task `bf7ab7`): when the WS transport reports a
 * generic stream error but the server-side message store holds a
 * complete answer, the banner is cosmetic — clear it. Decoded
 * (server-thrown) errors are never suppressed.
 */
describe("shouldClearStaleError", () => {
  it("preserves a decoded rate-limit error even with a usable assistant message", () => {
    // This is the "rate limit hit DURING a turn that already
    // produced a partial answer" case. The server-thrown envelope
    // is real and the user must see it; the message-store shape
    // alone isn't enough to suppress.
    const decoded = encodeAgentError({
      code: "rate_limit_chat_daily",
      message: "Daily limit reached",
      details: { retryAt: new Date().toISOString() },
    });
    const result = shouldClearStaleError({
      error: { message: decoded },
      lastAssistant: {
        role: "assistant",
        parts: [{ type: "text", text: "Here's a partial answer." }],
      },
    });
    expect(result).toBe(false);
  });

  it("clears a generic error when the last assistant message has text", () => {
    // The canonical bug-fix path. Spurious `data.error: true` chunk
    // tripped the transport but the assistant message is fully
    // populated.
    const result = shouldClearStaleError({
      error: { message: "BodyStreamBuffer encountered an error" },
      lastAssistant: {
        role: "assistant",
        parts: [{ type: "text", text: "Top customers by revenue: …" }],
      },
    });
    expect(result).toBe(true);
  });

  it("clears a generic error when status is permanently 'error' but the assistant is complete (chat 3a76a225)", () => {
    // Earlier this required `chatStatus === "ready"`. The bug
    // path keeps status at `"error"` indefinitely — we now decide
    // purely from the message-store shape so this case clears.
    const result = shouldClearStaleError({
      error: { message: "stream error" },
      lastAssistant: {
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-codemode",
            state: "output-available",
          },
          { type: "text", text: "Done." },
        ],
      },
    });
    expect(result).toBe(true);
  });

  it("keeps the banner when the last assistant only has a step-start (turn never produced output)", () => {
    // No usable content: refuse to suppress. This protects the
    // legitimate "turn died before any text/tool result" path.
    const result = shouldClearStaleError({
      error: { message: "stream error" },
      lastAssistant: {
        role: "assistant",
        parts: [{ type: "step-start" }],
      },
    });
    expect(result).toBe(false);
  });

  it("keeps the banner when the last message is from the user (assistant never replied)", () => {
    const result = shouldClearStaleError({
      error: { message: "stream error" },
      lastAssistant: {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    });
    expect(result).toBe(false);
  });

  it("returns false when there is no error", () => {
    expect(
      shouldClearStaleError({
        error: null,
        lastAssistant: {
          role: "assistant",
          parts: [{ type: "text", text: "Done" }],
        },
      })
    ).toBe(false);
  });

  it("treats a tool-call still in-flight as not-yet-usable", () => {
    // `state` other than `output-available` (e.g. `input-available`,
    // `streaming`) means the tool hasn't produced a result. We
    // shouldn't suppress on that alone.
    const result = shouldClearStaleError({
      error: { message: "stream error" },
      lastAssistant: {
        role: "assistant",
        parts: [{ type: "tool-codemode", state: "input-available" }],
      },
    });
    expect(result).toBe(false);
  });
});
