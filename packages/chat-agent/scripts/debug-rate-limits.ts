/**
 * Inspect a chat's current rate-limit usage. Useful when a user
 * reports being blocked from sending more turns and we want to see
 * which window is hot (chat-daily, user-hourly, tenant-daily).
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/debug-rate-limits.ts <chatId>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.argv[2];
if (!CHAT_ID) {
  console.error("usage: debug-rate-limits.ts <chatId>");
  process.exit(2);
}

function loadKey(): string {
  if (process.env.INTERNAL_JWT_SIGNING_KEY) return process.env.INTERNAL_JWT_SIGNING_KEY;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8");
      const m = text.match(/^INTERNAL_JWT_SIGNING_KEY="?([^"\n]+)"?/m);
      if (m) return m[1]!;
    } catch {
      // ignore
    }
  }
  throw new Error("INTERNAL_JWT_SIGNING_KEY not found");
}

interface RPC {
  debugRateLimits(): Promise<{
    ok: boolean;
    decision: {
      ok: boolean;
      code?: string;
      current?: number;
      max?: number;
      windowMs?: number;
    };
    tenantId: string | null;
  }>;
}

const token = await mintChatToken(loadKey(), {
  userId: "debug",
  chatId: CHAT_ID,
  tenantId: "debug",
});

const client = new AgentClient<RPC>({
  host: ENDPOINT,
  agent: "ChatAgent",
  name: CHAT_ID,
  query: { token },
});

await new Promise<void>((res, rej) => {
  client.addEventListener("open", () => res(), { once: true });
  client.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  setTimeout(() => rej(new Error("connect timeout")), 10_000);
});

try {
  const r = await client.call("debugRateLimits", []);
  console.log("\n=== rate-limit snapshot for chat", CHAT_ID, "===\n");
  console.log("tenantId      :", r.tenantId ?? "(unresolved)");
  console.log("overall ok    :", r.ok);
  console.log("decision      :", JSON.stringify(r.decision, null, 2));
  if (!r.decision.ok) {
    const minutes = r.decision.windowMs ? Math.round(r.decision.windowMs / 60_000) : "?";
    console.log(
      `\n⚠ blocked: ${r.decision.code} — ${r.decision.current}/${r.decision.max} in last ${minutes}min`
    );
  }
} finally {
  client.close();
}
