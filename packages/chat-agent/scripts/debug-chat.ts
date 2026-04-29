/**
 * Debug a specific chat by chatId.
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/debug-chat.ts <chatId>
 *
 * Mints an internal token, opens a WS to the chat-agent's RPC port,
 * and calls the `debugDump` callable. Prints the persisted message
 * history so you can see what (if anything) the model returned.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.argv[2];
if (!CHAT_ID) {
  console.error("usage: debug-chat.ts <chatId>");
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
  healthcheck(): Promise<{ ok: boolean }>;
  debugDump(opts?: { limit?: number }): Promise<{
    chatId: string;
    persistedMessageCount: number;
    messages: unknown[];
    cachedChatContext: unknown;
    currentTurnUserId: string | null;
    presence: { userId: string; joinedAt: number }[];
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
  const dump = await client.call("debugDump", [{ limit: 50 }]);
  console.log("\n=== debug dump for chat", CHAT_ID, "===\n");
  console.log("persistedMessageCount:", dump.persistedMessageCount);
  console.log("currentTurnUserId   :", dump.currentTurnUserId);
  console.log("presence            :", dump.presence);
  console.log("cachedChatContext   :", JSON.stringify(dump.cachedChatContext, null, 2));
  console.log("\nmessages (last", dump.messages.length, "):");
  for (let i = 0; i < dump.messages.length; i++) {
    const msg = dump.messages[i] as {
      role?: string;
      content?: string;
      parts?: unknown[];
      id?: string;
    };
    console.log(`\n--- [${i}] role=${msg.role} id=${msg.id?.slice(0, 12)} ---`);
    if (msg.parts) {
      for (const p of msg.parts) {
        const part = p as {
          type?: string;
          text?: string;
          toolName?: string;
          state?: string;
          input?: unknown;
          output?: unknown;
          errorText?: string;
        };
        // Truncation budget bumped 300/500 → 4000 (task 996861).
        // The earlier 300-char cap on input/output hid the codemode
        // `{error}` envelope on chat 5f2690a6 — the visible prefix
        // was the user's `async () =>` boilerplate; the meaningful
        // reject string lived past char 300. 4000 chars is plenty
        // for almost any codemode body and still small enough that
        // the dump comfortably fits in a terminal scrollback.
        // For genuinely-long bodies, use `inspect-codemode.ts`
        // (fully untruncated; same RPC).
        console.log(
          `  part type=${part.type}`,
          JSON.stringify({
            text: part.text?.slice(0, 4000),
            toolName: part.toolName,
            state: part.state,
            input: part.input ? JSON.stringify(part.input).slice(0, 4000) : undefined,
            output: part.output ? JSON.stringify(part.output).slice(0, 4000) : undefined,
            errorText: part.errorText?.slice(0, 4000),
          })
        );
      }
    } else if (msg.content) {
      console.log(" ", msg.content.slice(0, 4000));
    } else {
      console.log("  (no parts/content)", JSON.stringify(msg).slice(0, 4000));
    }
  }
} finally {
  client.close();
}
