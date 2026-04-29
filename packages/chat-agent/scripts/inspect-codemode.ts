/**
 * Untruncated codemode call inspector.
 *
 * Usage:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/inspect-codemode.ts <chatId> [assistantIndex]
 *
 * Same RPC pattern as `debug-chat.ts` — mints an internal token,
 * opens a WS to the chat-agent, calls `debugDump`. The diff:
 *
 *   - debug-chat.ts trims tool input/output/errorText to 300/300/500
 *     chars (a "fits on screen" preview).
 *   - This script prints them in full, plus parses the codemode
 *     `{code, result, error}` envelope so the user code body and
 *     the wrapped error string are both visible.
 *
 * Born from chat 5f2690a6 (task 996861) where the third codemode
 * call landed in `state="output-available"` with an error in the
 * wrapped output that debug-chat.ts was clipping. With this script:
 *
 *   $ tsx scripts/inspect-codemode.ts 5f2690a6-...
 *   ... [3] tool-codemode state=output-available
 *      input.code (full):
 *        async () => { const r = await memory.remember(f); ... }
 *      output (parsed):
 *        { error: "memory.remember: content is too long (...)",
 *          recoverable: true }
 *
 * Pass an assistantIndex (0-based) as the second arg to scope to
 * a single message; otherwise every assistant message's tool-codemode
 * parts are printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.argv[2];
const ASSISTANT_IDX_ARG = process.argv[3];
if (!CHAT_ID) {
  console.error("usage: inspect-codemode.ts <chatId> [assistantIndex]");
  process.exit(2);
}
const ASSISTANT_INDEX = ASSISTANT_IDX_ARG !== undefined ? Number(ASSISTANT_IDX_ARG) : null;
if (ASSISTANT_INDEX !== null && Number.isNaN(ASSISTANT_INDEX)) {
  console.error("assistantIndex must be a number");
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

interface CodemodePart {
  type?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/**
 * Parse the codemode tool I/O. The wrapper passes `{code: "..."}` as
 * input and the executor returns `{result, error?, logs?}`. Both
 * land as JSON-encoded strings half the time and as plain objects
 * the other half — handle both.
 */
function parseEnvelope(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function pretty(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

try {
  const dump = await client.call("debugDump", [{ limit: 50 }]);
  console.log("\n=== inspect-codemode for chat", CHAT_ID, "===");
  console.log("persistedMessageCount:", dump.persistedMessageCount);
  console.log("(no truncation — pipe to less / a file if output is large)\n");

  let assistantSeen = -1;
  for (let i = 0; i < dump.messages.length; i++) {
    const msg = dump.messages[i] as { role?: string; parts?: unknown[]; id?: string };
    if (msg.role !== "assistant") continue;
    assistantSeen += 1;
    if (ASSISTANT_INDEX !== null && assistantSeen !== ASSISTANT_INDEX) continue;

    const parts = (msg.parts as CodemodePart[] | undefined) ?? [];
    const codemodeParts = parts.filter((p) => p.type === "tool-codemode");
    if (codemodeParts.length === 0) continue;

    console.log(
      `\n=== assistant[#${assistantSeen}] (msgIdx=${i}, id=${msg.id?.slice(0, 12)}) — ${codemodeParts.length} codemode call${codemodeParts.length === 1 ? "" : "s"} ===`
    );
    for (let j = 0; j < codemodeParts.length; j++) {
      const part = codemodeParts[j]!;
      const input = parseEnvelope(part.input);
      const output = parseEnvelope(part.output);
      console.log(`\n  --- call [${j}] state=${part.state} ---`);
      console.log("  input.code (full):");
      const code =
        input && typeof input === "object" && "code" in (input as Record<string, unknown>)
          ? (input as { code?: unknown }).code
          : input;
      console.log(typeof code === "string" ? code : pretty(code));
      console.log("\n  output (parsed):");
      console.log(pretty(output));
      if (part.errorText) {
        console.log("\n  errorText (full):");
        console.log(part.errorText);
      }
    }
  }
  if (assistantSeen < 0) {
    console.log("(no assistant messages)");
  } else if (ASSISTANT_INDEX !== null && assistantSeen < ASSISTANT_INDEX) {
    console.log(
      `(assistantIndex ${ASSISTANT_INDEX} not found — only saw ${assistantSeen + 1} assistant message${assistantSeen === 0 ? "" : "s"})`
    );
  }
} finally {
  client.close();
}
