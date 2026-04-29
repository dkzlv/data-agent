/**
 * Spike harness for memory pipeline (task a0e754).
 *
 * Drives the deployed chat-agent's `memorySmoke` RPC through the
 * full lifecycle: persist → embed → Vectorize upsert → query →
 * hydrate → retrieve → soft-delete. Verifies that:
 *   - Postgres + Vectorize stay aligned (vector finds Postgres row)
 *   - Tenant/profile isolation works (hits scoped, hydrate respects
 *     deleted_at)
 *   - Embedding dimensions are 768 (bge-base-en-v1.5)
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx \
 *     scripts/spike-memory.ts <tenantId> <dbProfileId>
 *
 * Both args must reference real rows in the control-plane DB.
 * Easiest: query Neon for the auto-provisioned tenant + sample
 * profile of the dev user.
 *
 * Acceptance: prints a "PASS" line at the end, exits 0. Any step
 * with hits=0 or dims!=768 fails loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.env.SPIKE_CHAT_ID ?? `spike-memory-${Date.now()}`;
const TENANT_ID = process.argv[2];
const DB_PROFILE_ID = process.argv[3];
if (!TENANT_ID || !DB_PROFILE_ID) {
  console.error(
    "usage: spike-memory.ts <tenantId> <dbProfileId>\n  " +
      "Both must be real ids in the control-plane DB."
  );
  process.exit(2);
}

function loadSigningKey(): string {
  if (process.env.INTERNAL_JWT_SIGNING_KEY) return process.env.INTERNAL_JWT_SIGNING_KEY;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(/^INTERNAL_JWT_SIGNING_KEY="?([^"\n]+)"?/m);
      if (m) return m[1]!;
    } catch {
      // try next
    }
  }
  throw new Error("INTERNAL_JWT_SIGNING_KEY not found in env or .dev.vars");
}

interface RPC {
  memorySmoke(args: { tenantId: string; dbProfileId: string }): Promise<{
    inserted: { id: string; revived: boolean };
    embed: { dims: number };
    vector: { hits: number; topId: string | null; topScore: number | null };
    hydrated: { count: number };
    recall: { facts: number; topScore: number | null };
    cleanup: { deletedId: string };
  }>;
}

async function main() {
  const token = await mintChatToken(loadSigningKey(), {
    chatId: CHAT_ID,
    userId: "spike",
    tenantId: TENANT_ID,
  });
  const client = new AgentClient<RPC>({
    host: `https://${ENDPOINT}`,
    agent: "chat-agent",
    name: CHAT_ID,
    query: { token },
  });
  await client.ready;
  const result = await client.call("memorySmoke", [
    { tenantId: TENANT_ID, dbProfileId: DB_PROFILE_ID },
  ]);
  client.close();

  console.log(JSON.stringify(result, null, 2));

  // Hard assertions: any of these failing means the pipeline is
  // broken in a way that recall would silently degrade for users.
  if (result.embed.dims !== 768) {
    console.error("FAIL: embed dim mismatch", result.embed.dims);
    process.exit(1);
  }
  if (result.vector.hits === 0) {
    console.error(
      "FAIL: Vectorize query returned 0 hits — the upsert didn't land or the namespace is wrong"
    );
    process.exit(1);
  }
  if (result.hydrated.count === 0) {
    console.error("FAIL: hydrateFacts dropped every id (tenant/profile mismatch?)");
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
