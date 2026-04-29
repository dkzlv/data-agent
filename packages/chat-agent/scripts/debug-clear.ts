/**
 * Wipe the persisted message history for a chat. Use to recover from
 * a stuck assistant message (e.g. mid-stream crash, statement-timeout
 * loop) without forcing the user to start a new chat.
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/debug-clear.ts <chatId>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.argv[2];
if (!CHAT_ID) {
  console.error("usage: debug-clear.ts <chatId>");
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
  debugClearMessages(): Promise<{ ok: true; removed: number }>;
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
  const r = await client.call("debugClearMessages", []);
  console.log(`cleared ${r.removed} message(s) from ${CHAT_ID}`);
} finally {
  client.close();
}
