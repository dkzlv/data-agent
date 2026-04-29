/**
 * Sample-DB detection + demo prompt suggestions.
 *
 * The "sample" Postgres profile is auto-seeded for every new tenant
 * by `seedSampleDbProfile` in
 * `packages/api-gateway/src/session.ts:146` — a read-only Neon
 * employees DB. We want to surface tailored UX for it (welcome
 * route, prompt chips), but the schema doesn't carry an `is_sample`
 * column. We match by literal name.
 *
 * IMPORTANT: `SAMPLE_DB_NAME` MUST be kept in sync with the seed
 * name in `packages/api-gateway/src/session.ts`. If the seed is
 * renamed, demo detection silently breaks. There's a cross-reference
 * comment on the server side too. When we eventually add an
 * `is_sample` column, only this file needs to change.
 */
import type { DbProfile } from "./api";

export const SAMPLE_DB_NAME = "Sample: Neon employees DB";

export function isSampleProfile(p: { name: string }): boolean {
  return p.name === SAMPLE_DB_NAME;
}

export function findSampleProfile(profiles: DbProfile[]): DbProfile | undefined {
  return profiles.find(isSampleProfile);
}

/**
 * Curated prompts for the employees demo DB. `label` shows on the
 * chip; `prompt` is what's actually sent to the agent on click.
 * Keep prompts short, well-formed sentences — they're literal
 * messages, not search keywords.
 */
export const EMPLOYEES_DEMO_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Show schema",
    prompt: "List all tables in this database with row counts.",
  },
  {
    label: "Salary distribution",
    prompt: "Show the distribution of current salaries as a histogram.",
  },
  {
    label: "Hires per year",
    prompt: "Plot the number of employees hired per year as a line chart.",
  },
  {
    label: "Top earners",
    prompt: "Who are the 10 highest-paid employees right now? Show name, title, and salary.",
  },
  {
    label: "Birthdays by month",
    prompt: "Show the count of employee birthdays per calendar month as a bar chart.",
  },
];
