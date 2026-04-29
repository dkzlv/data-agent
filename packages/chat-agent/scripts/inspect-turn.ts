/**
 * Inspect a turn's lifecycle from the audit log.
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/inspect-turn.ts <chatId>
 *
 * What you get:
 *   - The audit timeline for the chat (last 30 events)
 *   - Per-turn summary: durationMs, status, tools used, abort fields
 *
 * For deeper debugging (per-step / per-chunk events) check Workers
 * Logs in the dashboard — filter by `turnId` from the output here
 * to get every span for that specific turn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const CHAT_ID = process.argv[2];
if (!CHAT_ID) {
  console.error("usage: inspect-turn.ts <chatId>");
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
try {
  const rows = await sql<
    {
      created_at: Date;
      action: string;
      user_id: string | null;
      payload: Record<string, unknown> | null;
    }[]
  >`
    SELECT created_at, action, user_id, payload
    FROM audit_log
    WHERE chat_id = ${CHAT_ID}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  if (rows.length === 0) {
    console.log(`No audit rows for chat ${CHAT_ID}`);
    process.exit(0);
  }
  rows.reverse(); // chronological for printing
  console.log(`\nAudit timeline for chat ${CHAT_ID} (${rows.length} events)\n`);

  // Group by turnId where available so we can see "this turn started
  // at X, completed/errored at Y, lasted Z, used tools [...]".
  const turnStarts = new Map<string, Date>();
  const seenTurnIds = new Set<string>();
  for (const r of rows) {
    const ts = r.created_at.toISOString().replace("T", " ").slice(0, 23);
    const turnId = (r.payload as { turnId?: string } | null)?.turnId ?? "(no-turn)";
    if (turnId !== "(no-turn)") seenTurnIds.add(turnId);
    if (r.action === "turn.start" && r.payload && "turnId" in r.payload) {
      turnStarts.set(turnId, r.created_at);
    }
    let extra = "";
    if (r.payload) {
      const p = r.payload as Record<string, unknown>;
      const interesting = [
        "status",
        "isAbort",
        "errorName",
        "stepCount",
        "chunkCount",
        "lastChunkType",
        "msSinceLastChunk",
        "durationMs",
        "abortLikelyFrom",
      ].filter((k) => p[k] != null);
      if (interesting.length) {
        extra = ` ${interesting.map((k) => `${k}=${JSON.stringify(p[k])}`).join(" ")}`;
      } else if (p["error"]) {
        extra = ` error=${String(p["error"]).slice(0, 80)}`;
      }
    }
    console.log(`${ts}  ${r.action.padEnd(20)} ${turnId.slice(0, 22).padEnd(22)}${extra}`);
  }

  if (seenTurnIds.size) {
    console.log(`\nTurn ids in this window:`);
    for (const id of seenTurnIds) console.log(`  ${id}`);
    console.log(
      `\nFor full per-step/per-chunk telemetry, open Workers Logs:\n` +
        `  https://dash.cloudflare.com/?to=/:account/workers/services/view/data-agent-chat-agent/production/observability/logs\n` +
        `and filter:\n` +
        `  turnId = "<id from above>"`
    );
  }
} finally {
  await sql.end();
}
