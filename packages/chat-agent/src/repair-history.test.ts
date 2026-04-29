import { describe, expect, it } from "vitest";
import { repairDanglingToolParts } from "./repair-history";

describe("repairDanglingToolParts", () => {
  it("returns the same array reference when history is clean", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "hello" },
          {
            type: "tool-codemode",
            toolName: "codemode",
            toolCallId: "tc_1",
            state: "output-available",
            input: { code: "..." },
            output: { ok: 1 },
          },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it("rewrites a dangling input-available tool part to output-error", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "show me a chart" }] },
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "let me introspect" },
          {
            type: "tool-codemode",
            toolName: "codemode",
            toolCallId: "tc_abc",
            state: "input-available",
            input: { code: "async () => db.introspect()" },
          },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(1);
    expect(r.messages).not.toBe(msgs);

    const repairedPart = (r.messages[1]!.parts as any[])[2];
    expect(repairedPart.state).toBe("output-error");
    expect(repairedPart.toolCallId).toBe("tc_abc");
    expect(repairedPart.toolName).toBe("codemode");
    // Input is preserved so the model can see what it tried to do.
    expect(repairedPart.input).toEqual({ code: "async () => db.introspect()" });
    // Error text is JSON with the canonical envelope.
    const env = JSON.parse(repairedPart.errorText);
    expect(env.error).toBe("tool_call_interrupted");
    expect(env.recoverable).toBe(true);
    expect(typeof env.message).toBe("string");
  });

  it("leaves the user message untouched", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-codemode",
            toolName: "codemode",
            toolCallId: "tc_1",
            state: "input-streaming",
            input: undefined,
          },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(1);
    // User message is reference-equal to the original.
    expect(r.messages[0]).toBe(msgs[0]);
  });

  it("repairs every non-terminal state", () => {
    const states = [
      "input-streaming",
      "input-available",
      "approval-requested",
      "approval-responded",
    ];
    for (const s of states) {
      const r = repairDanglingToolParts([
        {
          role: "assistant",
          parts: [
            {
              type: "tool-codemode",
              toolName: "codemode",
              toolCallId: "tc",
              state: s,
              input: {},
            },
          ],
        },
      ]);
      expect(r.repaired, `state=${s}`).toBe(1);
    }
  });

  it("does not touch terminal states", () => {
    const states = ["output-available", "output-error", "output-denied"];
    for (const s of states) {
      const msgs = [
        {
          role: "assistant",
          parts: [
            {
              type: "tool-codemode",
              toolName: "codemode",
              toolCallId: "tc",
              state: s,
              input: {},
              ...(s === "output-error" ? { errorText: "x" } : { output: { ok: 1 } }),
            },
          ],
        },
      ];
      const r = repairDanglingToolParts(msgs);
      expect(r.repaired, `state=${s}`).toBe(0);
      expect(r.messages).toBe(msgs);
    }
  });

  it("handles multiple dangling parts across messages", () => {
    const msgs = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-codemode",
            toolName: "codemode",
            toolCallId: "a",
            state: "input-available",
            input: {},
          },
          {
            type: "tool-codemode",
            toolName: "codemode",
            toolCallId: "b",
            state: "input-available",
            input: {},
          },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "continue" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "db_query",
            toolCallId: "c",
            state: "input-streaming",
            input: undefined,
          },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(3);
    expect(r.details).toHaveLength(3);
    expect(r.details[0]).toMatchObject({ messageIndex: 0, partIndex: 0, toolCallId: "a" });
    expect(r.details[1]).toMatchObject({ messageIndex: 0, partIndex: 1, toolCallId: "b" });
    expect(r.details[2]).toMatchObject({ messageIndex: 2, partIndex: 0, toolCallId: "c" });
  });

  it("treats parts with no `state` field as terminal (defensive)", () => {
    const msgs = [
      {
        role: "assistant",
        parts: [
          // No state — older message format. Don't rewrite.
          { type: "tool-codemode", toolName: "codemode", toolCallId: "x" },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it("ignores non-tool parts", () => {
    const msgs = [
      {
        role: "assistant",
        parts: [
          { type: "text", text: "hello" },
          { type: "reasoning", text: "thinking" },
          { type: "step-start" },
        ],
      },
    ];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(0);
    expect(r.messages).toBe(msgs);
  });

  it("handles empty / messages-without-parts gracefully", () => {
    const msgs = [
      { role: "user" },
      { role: "assistant", parts: [] },
      { role: "assistant" },
    ] as any[];
    const r = repairDanglingToolParts(msgs);
    expect(r.repaired).toBe(0);
    expect(r.messages).toBe(msgs);
  });
});
