/**
 * Spike harness for subtask 1b9bc9.
 *
 * 1. Connect to deployed chat-agent worker via the agents WS protocol.
 * 2. RPC: call healthcheck() on the agent.
 * 3. Chat: send a user message, listen for streamed response, verify the
 *    LLM (Kimi K2.6 on Workers AI) responds and Code Mode fires for the
 *    workspace question.
 * 4. Reconnect: verify message history is restored from DO SQLite.
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/spike.ts
 */
import { AgentClient } from "agents/client";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.env.SPIKE_CHAT_ID ?? `spike-${Date.now()}`;

console.log(`spike: wss://${ENDPOINT} chat=${CHAT_ID}\n`);

interface RPC {
  healthcheck(): Promise<{ ok: boolean; agent: string; chatId: string; time: string }>;
}

async function withClient<T>(fn: (c: AgentClient<RPC>) => Promise<T>): Promise<T> {
  const c = new AgentClient<RPC>({
    host: ENDPOINT,
    agent: "ChatAgent",
    name: CHAT_ID,
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("connect timeout")), 10_000);
    c.addEventListener("open", () => {
      clearTimeout(t);
      res();
    });
    c.addEventListener("error", (e) => {
      clearTimeout(t);
      rej(new Error(`ws error: ${(e as ErrorEvent).message ?? "unknown"}`));
    });
  });
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

async function step1_healthcheck() {
  console.log("[1/4] RPC healthcheck…");
  const r = await withClient(async (c) => c.call("healthcheck", []));
  console.log("  ✓", r);
}

interface ChatStreamResult {
  textChunks: number;
  toolEvents: number;
  finalText: string;
  doneSeen: boolean;
  error: string | null;
}

async function step2_chat(): Promise<ChatStreamResult> {
  console.log("\n[2/4] Send chat message via cf_agent_use_chat_request…");
  return await withClient(
    (client) =>
      new Promise<ChatStreamResult>((resolve) => {
        const requestId = `req-${Date.now()}`;
        const result: ChatStreamResult = {
          textChunks: 0,
          toolEvents: 0,
          finalText: "",
          doneSeen: false,
          error: null,
        };
        const timeout = setTimeout(() => {
          console.log("  ⏱ timed out after 90s");
          resolve(result);
        }, 90_000);

        client.addEventListener("message", (e) => {
          const raw = typeof e.data === "string" ? e.data : "";
          if (!raw) return;
          let data: { type?: string; id?: string; body?: string; done?: boolean; error?: boolean } =
            {};
          try {
            data = JSON.parse(raw);
          } catch {
            return;
          }

          if (data.type !== "cf_agent_use_chat_response") return;
          if (data.id !== requestId) return;

          if (data.error) {
            result.error = data.body ?? "stream error";
            console.log("  ✗ error chunk:", result.error);
            clearTimeout(timeout);
            resolve(result);
            return;
          }

          if (data.body) {
            // body is a JSON-encoded chunk from the AI SDK ui-message-stream.
            try {
              const chunk = JSON.parse(data.body) as {
                type?: string;
                delta?: string;
                text?: string;
              };
              if (chunk.type === "text-delta") {
                result.textChunks++;
                if (chunk.delta) result.finalText += chunk.delta;
              } else if (chunk.type?.startsWith("tool-")) {
                result.toolEvents++;
                if (result.toolEvents <= 3) console.log("    tool event:", chunk.type);
              }
            } catch {
              // not JSON, ignore
            }
          }

          if (data.done) {
            result.doneSeen = true;
            clearTimeout(timeout);
            resolve(result);
          }
        });

        // Wait a tick for listener wiring, then send.
        setTimeout(() => {
          const messages = [
            {
              id: `msg-${Date.now()}`,
              role: "user",
              parts: [
                {
                  type: "text",
                  text: "List the files in my workspace using state.readDir, then briefly tell me what you found.",
                },
              ],
            },
          ];
          const body = JSON.stringify({ messages, trigger: "submit-message" });
          client.send(
            JSON.stringify({
              id: requestId,
              type: "cf_agent_use_chat_request",
              init: { method: "POST", body },
            })
          );
          console.log("  → sent request id=" + requestId);
        }, 200);
      })
  );
}

async function step3_persistence(): Promise<{ messageCount: number }> {
  console.log("\n[3/4] Reconnect — verify message history persists…");
  return await withClient(
    (c) =>
      new Promise<{ messageCount: number }>((resolve) => {
        let count = 0;
        const timeout = setTimeout(() => resolve({ messageCount: count }), 5_000);
        c.addEventListener("message", (e) => {
          const raw = typeof e.data === "string" ? e.data : "";
          if (!raw) return;
          try {
            const data = JSON.parse(raw) as { type?: string; messages?: unknown[] };
            if (data.type === "cf_agent_chat_messages" && Array.isArray(data.messages)) {
              count = data.messages.length;
              clearTimeout(timeout);
              resolve({ messageCount: count });
            }
          } catch {
            // ignore
          }
        });
      })
  );
}

async function main() {
  await step1_healthcheck();
  const chat = await step2_chat();
  console.log(
    `  textChunks=${chat.textChunks} toolEvents=${chat.toolEvents} done=${chat.doneSeen}`
  );
  console.log(`  finalText: ${JSON.stringify(chat.finalText.slice(0, 240))}`);
  const persist = await step3_persistence();
  console.log(`  ✓ history count=${persist.messageCount}`);

  const codeRan = chat.toolEvents > 0;
  const responded = chat.finalText.length > 0 || chat.toolEvents > 0;
  const persisted = persist.messageCount >= 2;

  console.log("\n[4/4] SPIKE RESULT");
  console.log(`  WS routing            : ${"✓"}`);
  console.log(`  RPC method            : ${"✓"}`);
  console.log(`  Workers AI / Kimi K2.6: ${responded ? "✓" : "✗"}`);
  console.log(
    `  Code Mode fired       : ${codeRan ? "✓" : "?  (LLM may have answered without invoking code)"}`
  );
  console.log(`  Message persistence   : ${persisted ? "✓" : "✗"} (${persist.messageCount} msgs)`);

  if (!responded) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("\n✗ spike failed:", e);
  process.exit(1);
});
