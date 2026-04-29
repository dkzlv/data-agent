/**
 * Spike harness for subtask 2173ac (sandbox hardening).
 *
 * Verifies — against the deployed chat-agent — that the Code Mode
 * sandbox actually enforces the two guardrails we claim:
 *
 *  1. globalOutbound: null   → fetch() inside user code is blocked.
 *  2. timeout                → infinite-loop user code is killed.
 *
 * If either probe regresses (e.g. Worker Loader changing defaults),
 * this spike fails loudly and CI/dev catch it before users do.
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/spike-sandbox.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentClient } from "agents/client";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.env.SPIKE_CHAT_ID ?? `spike-sandbox-${Date.now()}`;

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
  sandboxNetworkProbe(): Promise<{
    fetchBlocked: boolean;
    connectBlocked: boolean;
    error?: string;
  }>;
  sandboxTimeoutProbe(): Promise<{
    timedOut: boolean;
    durationMs: number;
    errorPreview?: string;
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

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  const tag = ok ? "✓" : "✗";
  console.log(`${tag} ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

console.log(`spike-sandbox: wss://${ENDPOINT} chat=${CHAT_ID}\n`);

(async () => {
  // 1. Network isolation probe.
  const net = await withClient((c) => c.call("sandboxNetworkProbe", []));
  check("network: fetch() blocked", net.fetchBlocked, net);
  check("network: cross-origin Request blocked", net.connectBlocked, net);

  // 2. Timeout probe — should kill the infinite loop and return within ~3s.
  const t = await withClient((c) => c.call("sandboxTimeoutProbe", []));
  check("timeout: infinite loop killed", t.timedOut, t);
  check("timeout: killed within 5s budget", t.durationMs < 5_000, {
    durationMs: t.durationMs,
  });

  if (failed > 0) {
    console.error(`\n${failed} sandbox probe(s) failed`);
    process.exit(1);
  }
  console.log("\nall sandbox probes passed");
})().catch((err) => {
  console.error("spike-sandbox failed:", err);
  process.exit(1);
});
