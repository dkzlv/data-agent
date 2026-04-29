import { describe, expect, it } from "vitest";
import { validateSpec } from "./vega-lite-tools";

describe("vegaLite.validate", () => {
  it("accepts a minimal bar chart", () => {
    const r = validateSpec({
      data: { values: [{ a: 1, b: 2 }] },
      mark: "bar",
      encoding: {
        x: { field: "a", type: "nominal" },
        y: { field: "b", type: "quantitative" },
      },
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it("accepts a layered composition (no top-level mark)", () => {
    const r = validateSpec({
      data: { values: [] },
      layer: [{ mark: "line", encoding: { x: { field: "x", type: "quantitative" } } }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects missing data + missing mark", () => {
    const r = validateSpec({});
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("$.mark");
    expect(r.errors.map((e) => e.path)).toContain("$.data");
  });

  it("rejects unknown mark", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: "wibble",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === "$.mark")?.message).toMatch(/wibble/);
  });

  it("rejects bad encoding type", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: "bar",
      encoding: { x: { field: "a", type: "everythingelse" } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === "$.encoding.x.type")).toBeTruthy();
  });

  it("rejects unknown aggregate", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: "bar",
      encoding: { y: { field: "a", aggregate: "summarise" } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === "$.encoding.y.aggregate")).toBeTruthy();
  });

  it("rejects channel without field/value/datum/count-aggregate", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: "bar",
      encoding: { x: { type: "nominal" } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === "$.encoding.x")).toBeTruthy();
  });

  it("accepts aggregate count without field", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: "bar",
      encoding: { y: { aggregate: "count", type: "quantitative" } },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects v4 schema URL", () => {
    const r = validateSpec({
      $schema: "https://vega.github.io/schema/vega-lite/v4.json",
      data: { values: [] },
      mark: "bar",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === "$.$schema")).toBeTruthy();
  });

  it("accepts mark as object {type}", () => {
    const r = validateSpec({
      data: { values: [] },
      mark: { type: "point", filled: true },
      encoding: {
        x: { field: "a", type: "quantitative" },
        y: { field: "b", type: "quantitative" },
      },
    });
    expect(r.ok).toBe(true);
  });
});
