/**
 * Hard-delete every fact for a dbProfile + scrub Vectorize (task
 * a0e754).
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx \
 *     scripts/debug-memory-clear.ts <dbProfileId>
 *
 * Use during dogfood when bad extractions accumulated and a wipe
 * is faster than per-fact triage. Pairs with `inspect-memory.ts`
 * to dump first, then optionally clear.
 *
 * Safety:
 *   - Requires a dbProfileId arg (no "all profiles" mode).
 *   - Asks for typed confirmation (the literal profile id).
 *   - Postgres delete cascades from the profile-fk anyway, but we
 *     also pass through Vectorize.deleteByIds so the index doesn't
 *     keep stale vectors that the periodic sweep hasn't gotten to.
 *
 * The Postgres step uses a hard DELETE rather than the soft-delete
 * the UI uses — this is operational nuke-from-orbit, not the user
 * "Undo" path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import postgres from "postgres";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const DB_PROFILE_ID = process.argv[2];
if (!DB_PROFILE_ID) {
  console.error("usage: debug-memory-clear.ts <dbProfileId>");
  process.exit(2);
}

function loadVar(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8");
      const m = text.match(new RegExp(`^${name}="?([^"\\n]+)"?`, "m"));
      if (m) return m[1]!;
    } catch {
      // ignore
    }
  }
  throw new Error(`${name} not found in env or .dev.vars`);
}

async function confirm(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";

async function main() {
  // Confirm — the user must re-type the dbProfileId. Prevents
  // catastrophic copy-paste in the wrong terminal.
  const typed = await confirm(
    `This will HARD-DELETE every memory fact for db_profile_id=${DB_PROFILE_ID}.\n` +
      `Type the id to confirm: `
  );
  if (typed.trim() !== DB_PROFILE_ID) {
    console.error("Mismatch — aborting.");
    process.exit(1);
  }

  // Postgres pass: hard delete + capture ids so we can scrub
  // Vectorize next.
  const sql = postgres(loadVar("CONTROL_PLANE_DB_URL"), { max: 1, ssl: "require" });
  const rows = (await sql`
    DELETE FROM memory_fact
    WHERE db_profile_id = ${DB_PROFILE_ID}
    RETURNING id, tenant_id
  `) as unknown as Array<{ id: string; tenant_id: string }>;
  console.log(`postgres: deleted ${rows.length} rows`);

  if (rows.length === 0) {
    await sql.end({ timeout: 1 });
    console.log("nothing to scrub");
    return;
  }

  // Group by tenant for the agent RPC call (the agent doesn't
  // currently expose a "delete by ids" RPC, so we leverage a
  // service-binding approach: open one DO per tenant — tenant
  // == namespace in Vectorize). Simpler path: any DO in the same
  // worker shares the binding, so we can just drive any agent's
  // RPC. We use the first tenant's id as the chat name (anchors
  // a fresh DO).
  const tenantsTouched = new Set(rows.map((r) => r.tenant_id));
  const ids = rows.map((r) => r.id);
  await sql.end({ timeout: 1 });

  // Vectorize scrub — drive the agent's `debugMemoryDeleteVectors`
  // RPC. The V2 deleteByIds is namespace-agnostic at the call site,
  // so a single RPC against any DO is enough; we anchor to the
  // first tenant's id as the chat name to spawn a fresh DO that
  // doesn't collide with anything live.
  const anchorTenant = [...tenantsTouched][0]!;
  const chatName = `debug-memory-clear-${Date.now()}`;
  const token = await mintChatToken(loadVar("INTERNAL_JWT_SIGNING_KEY"), {
    chatId: chatName,
    userId: "ops",
    tenantId: anchorTenant,
  });
  interface RPC {
    debugMemoryDeleteVectors(args: { ids: string[]; tenantId: string }): Promise<{
      attempted: number;
    }>;
  }
  const client = new AgentClient<RPC>({
    host: `https://${ENDPOINT}`,
    agent: "chat-agent",
    name: chatName,
    query: { token },
  });
  await client.ready;
  const result = await client.call("debugMemoryDeleteVectors", [{ ids, tenantId: anchorTenant }]);
  client.close();
  console.log(`vectorize: scrubbed ${result.attempted} vectors`);
  console.log(`tenants touched: ${[...tenantsTouched].join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
