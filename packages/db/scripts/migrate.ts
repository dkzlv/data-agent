/**
 * Run pending Drizzle migrations against the control-plane DB.
 *
 * Usage:
 *   tsx scripts/migrate.ts
 *
 * Reads CONTROL_PLANE_DB_URL from env. Loads .dev.vars if present.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Tiny dotenv-ish loader so we don't pull in a dep just to read .dev.vars
function loadDevVars(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (!key) continue;
    if (process.env[key]) continue;
    let value = raw ?? "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadDevVars(resolve(here, "../../../.dev.vars"));
loadDevVars(resolve(here, "../.dev.vars"));

const url = process.env.CONTROL_PLANE_DB_URL;
if (!url) {
  console.error(
    "error: CONTROL_PLANE_DB_URL not set (checked env, root .dev.vars, package .dev.vars)"
  );
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);

console.log("Running migrations…");
await migrate(db, { migrationsFolder: resolve(here, "../migrations") });
console.log("Done.");
await client.end();
