/**
 * Dump top facts for a dbProfile (task a0e754).
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx \
 *     scripts/inspect-memory.ts <dbProfileId>
 *
 * What you get:
 *   - Total alive facts for the profile
 *   - Group counts by `kind`
 *   - Top 20 most-recalled facts (highest hitCount)
 *   - 5 most recent facts
 *
 * Useful when investigating "is the agent learning anything?" or
 * "is the extractor saving spam we should kill?".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const DB_PROFILE_ID = process.argv[2];
if (!DB_PROFILE_ID) {
  console.error("usage: inspect-memory.ts <dbProfileId>");
  process.exit(2);
}

function loadDbUrl(): string {
  if (process.env.CONTROL_PLANE_DB_URL) return process.env.CONTROL_PLANE_DB_URL;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8");
      const m = text.match(/^CONTROL_PLANE_DB_URL="?([^"\n]+)"?/m);
      if (m) return m[1]!;
    } catch {
      // ignore
    }
  }
  throw new Error("CONTROL_PLANE_DB_URL not found");
}

const sql = postgres(loadDbUrl(), { max: 1, ssl: "require" });

async function main() {
  const [{ count }] = (await sql`
    SELECT count(*)::int AS count FROM memory_fact
    WHERE db_profile_id = ${DB_PROFILE_ID} AND deleted_at IS NULL
  `) as unknown as [{ count: number }];

  const byKind = (await sql`
    SELECT kind, count(*)::int AS count FROM memory_fact
    WHERE db_profile_id = ${DB_PROFILE_ID} AND deleted_at IS NULL
    GROUP BY kind ORDER BY count DESC
  `) as unknown as Array<{ kind: string; count: number }>;

  const topUsed = (await sql`
    SELECT id, kind, content, hit_count, last_used_at, created_at
    FROM memory_fact
    WHERE db_profile_id = ${DB_PROFILE_ID} AND deleted_at IS NULL
    ORDER BY hit_count DESC, last_used_at DESC NULLS LAST
    LIMIT 20
  `) as unknown as Array<{
    id: string;
    kind: string;
    content: string;
    hit_count: number;
    last_used_at: Date | null;
    created_at: Date;
  }>;

  const recent = (await sql`
    SELECT id, kind, content, hit_count, created_at
    FROM memory_fact
    WHERE db_profile_id = ${DB_PROFILE_ID} AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  `) as unknown as Array<{
    id: string;
    kind: string;
    content: string;
    hit_count: number;
    created_at: Date;
  }>;

  console.log(`# memory_fact for db_profile_id=${DB_PROFILE_ID}`);
  console.log(`Total alive: ${count}`);
  console.log(``);
  console.log(`## By kind`);
  for (const row of byKind) {
    console.log(`  ${row.kind.padEnd(22)} ${row.count}`);
  }
  console.log(``);
  console.log(`## Top recalled (hitCount desc)`);
  for (const f of topUsed) {
    console.log(
      `  [${f.kind}] (${f.hit_count}×) ${f.content.length > 100 ? f.content.slice(0, 100) + "…" : f.content}`
    );
    console.log(`     id=${f.id} created=${f.created_at.toISOString()}`);
  }
  console.log(``);
  console.log(`## Most recent`);
  for (const f of recent) {
    console.log(
      `  [${f.kind}] ${f.content.length > 100 ? f.content.slice(0, 100) + "…" : f.content}`
    );
    console.log(`     id=${f.id} created=${f.created_at.toISOString()}`);
  }

  await sql.end({ timeout: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
