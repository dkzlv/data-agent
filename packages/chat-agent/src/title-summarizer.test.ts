import { describe, expect, it } from "vitest";
import {
  extractFirstUserText,
  sanitizeTitle,
  TITLE_SUMMARY_SYSTEM_PROMPT,
} from "./title-summarizer";

describe("sanitizeTitle", () => {
  it("returns null for null/undefined/empty", () => {
    expect(sanitizeTitle(null)).toBeNull();
    expect(sanitizeTitle(undefined)).toBeNull();
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   ")).toBeNull();
  });

  it("strips wrapping straight quotes", () => {
    expect(sanitizeTitle('"Top Customers Last Quarter"')).toBe("Top Customers Last Quarter");
    expect(sanitizeTitle("'Revenue Trend Analysis'")).toBe("Revenue Trend Analysis");
  });

  it("strips wrapping curly/backtick quotes", () => {
    expect(sanitizeTitle("`Order Volume Last Week`")).toBe("Order Volume Last Week");
    expect(sanitizeTitle("\u201CChurn Rate by Plan\u201D")).toBe("Churn Rate by Plan");
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("Top Customers by Revenue.")).toBe("Top Customers by Revenue");
    expect(sanitizeTitle("Sales Insights!")).toBe("Sales Insights");
    expect(sanitizeTitle("Funnel Drop-Off?;,")).toBe("Funnel Drop-Off");
  });

  it("strips leading 'Title:' / '# ' prefixes", () => {
    expect(sanitizeTitle("Title: Active Users by Country")).toBe("Active Users by Country");
    expect(sanitizeTitle("title:  Q4 Funnel Review")).toBe("Q4 Funnel Review");
    expect(sanitizeTitle("# Monthly Revenue Trend")).toBe("Monthly Revenue Trend");
  });

  it("collapses internal whitespace runs", () => {
    expect(sanitizeTitle("Top   Customers\nby\tRevenue")).toBe("Top Customers by Revenue");
  });

  it("rejects single-word output as failure", () => {
    expect(sanitizeTitle("Untitled")).toBeNull();
    expect(sanitizeTitle('"chat"')).toBeNull();
  });

  it("rejects 9+ word essays as failure", () => {
    expect(sanitizeTitle("This is way too long a title for a tiny header field")).toBeNull();
  });

  it("accepts the 2-word boundary", () => {
    expect(sanitizeTitle("Sales Insights")).toBe("Sales Insights");
  });

  it("accepts the 8-word boundary", () => {
    expect(sanitizeTitle("Top Eight Customers Ranked by Quarterly Net Revenue")).toBe(
      "Top Eight Customers Ranked by Quarterly Net Revenue"
    );
  });

  it("truncates over-80-char output at last word boundary", () => {
    // 7 words but very long if each were huge. Construct a string
    // that's 6 words but >80 chars: each word ~16 chars.
    const huge = "Aaaaaaaaaaaaaaa Bbbbbbbbbbbbbbb Cccccccccccccc Ddddddddddd Eeeeeeeeeeeee";
    // 73 chars — under cap, passes through.
    expect(sanitizeTitle(huge)).toBe(huge);

    // Now 6 words that sum > 80 chars:
    const longer =
      "Veryyyyyyyyyyyyy Looooooooooooong Tiiiiiiiiiiiiitle Wiiiiiiiiiith Toooooooo Many";
    const result = sanitizeTitle(longer);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    // Should not end mid-word.
    expect(result!.endsWith(" ")).toBe(false);
  });

  it("survives combined messy input", () => {
    expect(sanitizeTitle('  "Title: Top Five Customers This Quarter."  ')).toBe(
      "Top Five Customers This Quarter"
    );
  });

  it("system prompt is stable", () => {
    expect(TITLE_SUMMARY_SYSTEM_PROMPT).toContain("3-6 word title");
    expect(TITLE_SUMMARY_SYSTEM_PROMPT).toContain("Title case");
  });
});

describe("extractFirstUserText", () => {
  it("returns null for non-objects", () => {
    expect(extractFirstUserText(null)).toBeNull();
    expect(extractFirstUserText(undefined)).toBeNull();
    expect(extractFirstUserText("hello")).toBeNull();
    expect(extractFirstUserText(42)).toBeNull();
  });

  it("returns null when parts is missing or wrong shape", () => {
    expect(extractFirstUserText({})).toBeNull();
    expect(extractFirstUserText({ parts: "not an array" })).toBeNull();
    expect(extractFirstUserText({ parts: [] })).toBeNull();
  });

  it("extracts a single text part", () => {
    expect(
      extractFirstUserText({
        role: "user",
        parts: [{ type: "text", text: "show top 5 customers" }],
      })
    ).toBe("show top 5 customers");
  });

  it("concatenates multiple text parts with newlines", () => {
    expect(
      extractFirstUserText({
        parts: [
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
        ],
      })
    ).toBe("first paragraph\nsecond paragraph");
  });

  it("skips non-text parts (tool, reasoning, step-start)", () => {
    expect(
      extractFirstUserText({
        parts: [
          { type: "step-start" },
          { type: "text", text: "the actual question" },
          { type: "tool-foo", input: { sql: "SELECT 1" } },
          { type: "reasoning", text: "ignore this" },
        ],
      })
    ).toBe("the actual question");
  });

  it("returns null when there are parts but none are text", () => {
    expect(
      extractFirstUserText({
        parts: [{ type: "step-start" }, { type: "tool-foo", input: {} }],
      })
    ).toBeNull();
  });

  it("truncates input over 1500 chars", () => {
    const long = "a".repeat(2000);
    const result = extractFirstUserText({ parts: [{ type: "text", text: long }] });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1500);
  });

  it("trims surrounding whitespace", () => {
    expect(
      extractFirstUserText({
        parts: [{ type: "text", text: "   leading and trailing   " }],
      })
    ).toBe("leading and trailing");
  });

  it("returns null when text parts are all empty", () => {
    expect(
      extractFirstUserText({
        parts: [
          { type: "text", text: "   " },
          { type: "text", text: "" },
        ],
      })
    ).toBeNull();
  });
});
