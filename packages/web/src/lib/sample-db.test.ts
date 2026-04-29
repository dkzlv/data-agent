import { describe, expect, it } from "vitest";
import {
  EMPLOYEES_DEMO_PROMPTS,
  SAMPLE_DB_NAME,
  findSampleProfile,
  isSampleProfile,
} from "./sample-db";
import type { DbProfile } from "./api";

function profile(name: string): DbProfile {
  return {
    id: `id-${name}`,
    name,
    host: "h",
    port: 5432,
    database: "d",
    sslmode: "require",
    lastTestedAt: null,
    lastTestedStatus: "never",
    createdAt: new Date().toISOString(),
  };
}

describe("isSampleProfile", () => {
  it("returns true for the exact seed name", () => {
    expect(isSampleProfile({ name: SAMPLE_DB_NAME })).toBe(true);
  });

  it("returns false for any other name", () => {
    expect(isSampleProfile({ name: "Production" })).toBe(false);
    expect(isSampleProfile({ name: "" })).toBe(false);
    expect(isSampleProfile({ name: SAMPLE_DB_NAME.toLowerCase() })).toBe(false);
    expect(isSampleProfile({ name: ` ${SAMPLE_DB_NAME}` })).toBe(false);
  });
});

describe("findSampleProfile", () => {
  it("finds the sample profile in a mixed list", () => {
    const profiles = [profile("Production"), profile(SAMPLE_DB_NAME), profile("Staging")];
    const sample = findSampleProfile(profiles);
    expect(sample?.name).toBe(SAMPLE_DB_NAME);
  });

  it("returns undefined when no sample profile present", () => {
    const profiles = [profile("Production"), profile("Staging")];
    expect(findSampleProfile(profiles)).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(findSampleProfile([])).toBeUndefined();
  });
});

describe("EMPLOYEES_DEMO_PROMPTS", () => {
  it("ships at least 5 distinct prompts with non-empty labels and prompts", () => {
    expect(EMPLOYEES_DEMO_PROMPTS.length).toBeGreaterThanOrEqual(5);
    const labels = new Set(EMPLOYEES_DEMO_PROMPTS.map((p) => p.label));
    expect(labels.size).toBe(EMPLOYEES_DEMO_PROMPTS.length);
    for (const { label, prompt } of EMPLOYEES_DEMO_PROMPTS) {
      expect(label.trim().length).toBeGreaterThan(0);
      expect(prompt.trim().length).toBeGreaterThan(0);
    }
  });
});
