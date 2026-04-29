import { describe, expect, it } from "vitest";
import { buildTurnTranscript, parseExtractOutput } from "./extract";
import { buildFullTranscript, countUserMessages } from "./summarize-chat";

describe("buildTurnTranscript", () => {
  it("returns empty for no user message", () => {
    expect(buildTurnTranscript([])).toBe("");
    expect(
      buildTurnTranscript([{ role: "assistant", parts: [{ type: "text", text: "hi" }] }])
    ).toBe("");
  });

  it("includes only the last user message and what came after (this turn)", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "old question" }] },
      { role: "assistant", parts: [{ type: "text", text: "old answer" }] },
      { role: "user", parts: [{ type: "text", text: "new question about orders" }] },
      { role: "assistant", parts: [{ type: "text", text: "the answer is 42" }] },
    ];
    const t = buildTurnTranscript(msgs);
    expect(t).toContain("new question about orders");
    expect(t).toContain("the answer is 42");
    expect(t).not.toContain("old question");
    expect(t).not.toContain("old answer");
  });

  it("renders tool calls as compact name+output markers", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        parts: [
          { type: "tool-codemode", toolName: "codemode", output: { rows: [{ a: 1 }] } },
          { type: "text", text: "done" },
        ],
      },
    ];
    const t = buildTurnTranscript(msgs);
    expect(t).toContain("[tool=codemode]");
    expect(t).toContain('"rows"');
    expect(t).toContain("done");
  });
});

describe("parseExtractOutput", () => {
  it("parses well-formed JSON", () => {
    const r = parseExtractOutput(
      JSON.stringify({
        facts: [{ kind: "schema_semantic", content: "orders.total_cents is in cents not dollars" }],
      })
    );
    expect(r.facts.length).toBe(1);
    expect(r.facts[0]!.kind).toBe("schema_semantic");
  });

  it("strips markdown code fences", () => {
    const raw =
      '```json\n{"facts":[{"kind":"business_def","content":"MRR uses active subscriptions"}]}\n```';
    const r = parseExtractOutput(raw);
    expect(r.facts.length).toBe(1);
  });

  it("rejects unknown kinds", () => {
    const r = parseExtractOutput(
      JSON.stringify({ facts: [{ kind: "fake_kind", content: "this should not survive" }] })
    );
    expect(r.facts.length).toBe(0);
  });

  it("rejects chat_summary kind (reserved for system)", () => {
    const r = parseExtractOutput(
      JSON.stringify({ facts: [{ kind: "chat_summary", content: "blah blah blah blah blah" }] })
    );
    expect(r.facts.length).toBe(0);
  });

  it("rejects too-short content", () => {
    const r = parseExtractOutput(
      JSON.stringify({ facts: [{ kind: "schema_semantic", content: "ok" }] })
    );
    expect(r.facts.length).toBe(0);
  });

  it("caps at 3 facts even when the model returns more", () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({
      kind: "schema_semantic" as const,
      content: `fact number ${i} that's long enough`,
    }));
    const r = parseExtractOutput(JSON.stringify({ facts }));
    expect(r.facts.length).toBe(3);
  });

  it("returns empty on malformed input", () => {
    expect(parseExtractOutput("").facts.length).toBe(0);
    expect(parseExtractOutput("not json").facts.length).toBe(0);
    expect(parseExtractOutput("null").facts.length).toBe(0);
    expect(parseExtractOutput('{"oops": true}').facts.length).toBe(0);
  });
});

describe("countUserMessages", () => {
  it("counts only user-role messages", () => {
    const msgs = [
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
      { role: "system" },
      { role: "user" },
    ];
    expect(countUserMessages(msgs)).toBe(3);
  });
});

describe("buildFullTranscript", () => {
  it("includes every user + assistant text part", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "first q" }] },
      { role: "assistant", parts: [{ type: "text", text: "first a" }] },
      { role: "user", parts: [{ type: "text", text: "second q" }] },
    ];
    const t = buildFullTranscript(msgs);
    expect(t).toContain("first q");
    expect(t).toContain("first a");
    expect(t).toContain("second q");
  });

  it("renders tool calls as `(tool: name)` markers", () => {
    const msgs = [
      {
        role: "assistant",
        parts: [{ type: "tool-codemode", toolName: "codemode" }],
      },
    ];
    const t = buildFullTranscript(msgs);
    expect(t).toContain("(tool: codemode)");
  });
});
