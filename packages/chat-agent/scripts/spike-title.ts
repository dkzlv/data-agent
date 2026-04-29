/**
 * Spike harness for task 0cc87b (title generation regression).
 *
 * Calls the deployed chat-agent's `debugTitleProbe` RPC with a sample
 * user message and prints the raw + sanitized title plus token /
 * char counts. Used to verify that disabling thinking on the title
 * call actually produces visible text on Kimi K2.6.
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/spike-title.ts \
 *     "show top 5 customers by revenue"
 *
 * Acceptance: prints a non-null sanitized title, non-zero outputTokens,
 * and exits 0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.env.SPIKE_CHAT_ID ?? `spike-title-${Date.now()}`;
const PROMPT = process.argv[2] ?? "show top 5 customers by revenue last quarter";

function loadSigningKey(): string {
  if (process.env.INTERNAL_JWT_SIGNING_KEY) return process.env.INTERNAL_JWT_SIGNING_KEY;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(/^INTERNAL_JWT_SIGNING_KEY="?([^"\n]+)"?/m);
      if (m) return m[1]!;
    } catch {
      // file not present, try next
    }
  }
  throw new Error("INTERNAL_JWT_SIGNING_KEY not found in env or .dev.vars");
}

const SIGNING_KEY = loadSigningKey();

interface RPC {
  debugTitleProbe(text: string): Promise<{
    ok: boolean;
    rawTitle: string;
    sanitized: string | null;
    outputChars: number;
    reasoningChars: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    durationMs: number;
    error?: string;
  }>;
}

async function withClient<T>(fn: (c: AgentClient<RPC>) => Promise<T>): Promise<T> {
  const token = await mintChatToken(SIGNING_KEY, {
    userId: "spike-user",
    chatId: CHAT_ID,
    tenantId: "spike-tenant",
  });
  const c = new AgentClient<RPC>({
    host: ENDPOINT,
    agent: "ChatAgent",
    name: CHAT_ID,
    query: { token },
  });
  await new Promise<void>((res, rej) => {
    c.addEventListener("open", () => res(), { once: true });
    c.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    setTimeout(() => rej(new Error("ws connect timeout")), 10_000);
  });
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

console.log(`spike-title: wss://${ENDPOINT} chat=${CHAT_ID}`);
console.log(`prompt: "${PROMPT}"\n`);

(async () => {
  const out = await withClient((c) => c.call("debugTitleProbe", [PROMPT]));
  console.log(JSON.stringify(out, null, 2));

  let failed = 0;
  const check = (name: string, ok: boolean): void => {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed++;
  };

  check("RPC succeeded", out.ok === true);
  check("non-empty rawTitle", out.outputChars > 0);
  check("sanitized title non-null", out.sanitized !== null);
  check("outputTokens > 0", (out.outputTokens ?? 0) > 0);

  if (failed > 0) {
    console.error(`\n${failed} title probe check(s) failed`);
    process.exit(1);
  }
  console.log("\nall title probe checks passed");
})().catch((err) => {
  console.error("spike-title failed:", err);
  process.exit(1);
});
