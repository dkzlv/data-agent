import { defineConfig } from "drizzle-kit";

const url = process.env.CONTROL_PLANE_DB_URL;
if (!url) {
  throw new Error("CONTROL_PLANE_DB_URL is required. Add it to .dev.vars or set it in your shell.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
  // Fail loudly on changes so CI can detect uncommitted schema drift.
  strict: true,
  verbose: true,
});
