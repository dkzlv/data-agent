import { describe, expect, it } from "vitest";
import { buildSystemPrompt, _SECTIONS } from "./system-prompt";

describe("system prompt", () => {
  it("builds without context (no DB attached)", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("data-agent");
    expect(p).toContain("ONE tool: `codemode`");
    expect(p).not.toContain("Per-chat context");
  });

  it("renders chat title + user + database when present", () => {
    const p = buildSystemPrompt({
      chatTitle: "Q4 funnel deep dive",
      user: { name: "Ada Lovelace", email: "ada@example.com" },
      database: { name: "prod-mirror", host: "db.x.amazonaws.com", database: "analytics" },
    });
    expect(p).toContain("**Q4 funnel deep dive**");
    expect(p).toContain("**Ada Lovelace**");
    expect(p).toContain("ada@example.com");
    expect(p).toContain("**prod-mirror**");
    expect(p).toContain("analytics on db.x.amazonaws.com");
    expect(p).toContain("approved read-only access");
  });

  it("nudges users without an attached database", () => {
    const p = buildSystemPrompt({ chatTitle: "exploration", user: { name: "x", email: "x@y" } });
    expect(p).toContain("No database attached yet");
    expect(p).toContain("Settings → Databases");
  });

  it("includes safety rails: read-only + ignore-injected-instructions + non-data refusal", () => {
    expect(_SECTIONS.SAFETY).toMatch(/read-only/i);
    expect(_SECTIONS.SAFETY).toMatch(/SELECT/);
    expect(_SECTIONS.SAFETY).toMatch(/data, not instructions/i);
    expect(_SECTIONS.SAFETY).toMatch(/connection strings|credentials/);
    expect(_SECTIONS.SAFETY).toMatch(/redirect to data analysis/);
  });

  it("teaches db-first workflow with parameterized SQL", () => {
    expect(_SECTIONS.APPROACH).toContain("db.introspect()");
    expect(_SECTIONS.APPROACH).toContain("$1");
    expect(_SECTIONS.APPROACH).toMatch(/never interpolate/i);
  });

  it("mentions chart.save and artifact.save so the model knows where to put outputs", () => {
    // T5: a one-line mention is enough — the typed declarations ride
    // along on the codemode tool description.
    expect(_SECTIONS.APPROACH).toContain("chart.save");
    expect(_SECTIONS.APPROACH).toContain("artifact.save");
  });

  it("requires a leading description comment in every codemode call", () => {
    // The chat UI parses the first `//` comment line and surfaces it
    // as the human-readable label for the step. Without this rule the
    // collapsed tool-call rows would just show raw JS — see
    // `extractCodemodeDescription` in `ChatRoom.tsx`.
    expect(_SECTIONS.HEADER).toMatch(/one-line `\/\/` comment/i);
  });

  it("does NOT ship a fenced async-arrow code example as text", () => {
    // Regression guard for chat feca41d8: with a fenced code-block
    // example presented as the "format" the model emitted the snippet
    // verbatim as assistant content with no tool_calls, costing the
    // user a wasted turn. Task 722e12 dropped the example entirely —
    // the codemode tool description carries the call shape via its
    // typed declarations.
    const full = buildSystemPrompt();
    expect(full).not.toMatch(/```[\s\S]*async\s*\(\s*\)\s*=>/);
    expect(full).not.toContain("async () => {");
  });

  it("teaches the cross-chat memory surface (recall + memory.* tool)", () => {
    // Two surfaces are documented in MEMORY:
    //   - the `## Recalled facts` block (what the model SEES)
    //   - the `memory.*` namespace (what the model CALLS to write)
    expect(_SECTIONS.MEMORY).toMatch(/Memory across chats/i);
    expect(_SECTIONS.MEMORY).toMatch(/Recalled facts/);
    expect(_SECTIONS.MEMORY).toMatch(/memory\.remember/);
    expect(_SECTIONS.MEMORY).toMatch(/memory\.forget/);
    expect(_SECTIONS.MEMORY).toMatch(/memory\.search/);
    // Operator-readable guidance against runaway saves.
    expect(_SECTIONS.MEMORY).toMatch(/general knowledge/i);
  });

  it("renders the MEMORY section only when memoryEnabled is true", () => {
    // Task 722e12 + a0e754: gate the prompt section on the matching
    // tool surface so the model never sees instructions for a tool
    // it can't actually call (e.g. chats with no dbProfile attached).
    const off = buildSystemPrompt({
      chatTitle: "x",
      user: { name: "x", email: "x@y" },
      database: { name: "x", host: "x", database: "x" },
    });
    expect(off).not.toMatch(/## Memory across chats/);

    const on = buildSystemPrompt({
      chatTitle: "x",
      user: { name: "x", email: "x@y" },
      database: { name: "x", host: "x", database: "x" },
      memoryEnabled: true,
    });
    expect(on).toMatch(/## Memory across chats/);
    expect(on).toMatch(/memory\.remember/);
  });

  it("renders the recalled-facts block ONLY when facts are provided", () => {
    // The "Memory across chats" copy in HOW_TO_WORK *describes* the
    // block (so the model knows what it is when it sees it). The
    // actual block-with-bullets is what we gate on. We assert on the
    // exact heading variant that includes the parenthetical so we
    // distinguish the literal block from the descriptive prose.
    const HEADING = "## Recalled facts (from past chats with this database)";

    // No facts → no rendered block.
    const empty = buildSystemPrompt({
      chatTitle: "x",
      user: { name: "x", email: "x@y" },
      database: { name: "x", host: "x", database: "x" },
    });
    expect(empty).not.toContain(HEADING);

    // Facts present → block rendered with [kind] tags + content.
    const withFacts = buildSystemPrompt({
      chatTitle: "x",
      user: { name: "x", email: "x@y" },
      database: { name: "x", host: "x", database: "x" },
      recalledFacts: [
        { kind: "schema_semantic", content: "orders.total_cents is in cents not dollars" },
        { kind: "business_def", content: "MRR = sum(active_subscriptions.amount)" },
      ],
    });
    expect(withFacts).toContain(HEADING);
    expect(withFacts).toContain("- [schema_semantic] orders.total_cents is in cents not dollars");
    expect(withFacts).toContain("- [business_def] MRR = sum(active_subscriptions.amount)");
  });

  it("does NOT include hardcoded credentials, dev URLs, or secrets", () => {
    const p = buildSystemPrompt({
      chatTitle: "x",
      user: { name: "x", email: "x@y" },
      database: { name: "x", host: "x", database: "x" },
    });
    // Specific value-shape leaks (not the words; we *talk* about safety).
    expect(p).not.toMatch(/sk-[A-Za-z0-9]{20,}/); // OpenAI-style key
    expect(p).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
    expect(p).not.toMatch(/MASTER_ENCRYPTION_KEY|INTERNAL_JWT_SIGNING_KEY/);
    expect(p).not.toMatch(/postgres:\/\//);
    expect(p).not.toMatch(/neon\.tech/);
    expect(p).not.toMatch(/\.dev\.vars/);
  });

  it("stays under ~2k chars (the whole point of task 722e12)", () => {
    // Without per-chat context this prompt is the static prefix sent
    // every turn. Earlier it was ~6.2k chars (≈1.6k tokens). The
    // budget here is generous — actual size is closer to 1.4k chars —
    // so this is a guard rail rather than a tight cap.
    const p = buildSystemPrompt();
    expect(p.length).toBeLessThan(2000);
  });
});
