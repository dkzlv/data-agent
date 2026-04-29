/**
 * `/get-messages` route smoke test (task `bf7ab7`).
 *
 * Verifies the chain that Phase 1 wires up:
 *
 *   browser ──HTTP──▶ api-gateway `/api/chats/:id/ws/get-messages`
 *                       ├─ requireSession()
 *                       ├─ membership check
 *                       ├─ mint chat-token
 *                       └──forward──▶ chat-agent `/agents/chat-agent/:id/get-messages`
 *                                       ├─ onBeforeRequest verifies chat-token
 *                                       └─ Think.onRequest returns this.messages
 *
 * The gateway leg is session-cookie-gated and we can't easily mint a
 * Better Auth session from a script — so this spike targets the
 * chat-agent worker directly, which is the leg that actually serves
 * the JSON. The gateway proxy is a thin auth-wrapper above this; if
 * the chat-agent endpoint works and the gateway's existing artifact
 * proxies (which use the identical proxy pattern) work, the new route
 * works.
 *
 * Asserts:
 *  - 200 + JSON array when called with a valid chat-token.
 *  - 401 when called without a token.
 *  - 401 when the token is for a *different* chatId (defense-in-depth).
 *
 * Run:
 *   pnpm --filter @data-agent/api-gateway exec tsx scripts/spike-get-messages.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mintChatToken } from "@data-agent/shared";

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const CHAT_ID = process.env.SPIKE_CHAT_ID ?? `spike-getmsgs-${Date.now()}`;

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

const SIGNING_KEY = loadSigningKey();

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

const url = `https://${ENDPOINT}/agents/chat-agent/${encodeURIComponent(CHAT_ID)}/get-messages`;

console.log(`spike: GET ${url}\n`);

// 1. Happy path — valid token, expect 200 + JSON array.
{
  const token = await mintChatToken(SIGNING_KEY, {
    userId: "spike-user",
    chatId: CHAT_ID,
    tenantId: "spike-tenant",
  });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  check("authorized request → 200", res.status === 200, { status: res.status });
  if (res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      check("response body is JSON", false, String(err));
      body = null;
    }
    check("response body is an array", Array.isArray(body), {
      sample: Array.isArray(body) ? body.slice(0, 1) : body,
      length: Array.isArray(body) ? body.length : null,
    });
  }
}

// 2. Missing token — expect 401.
{
  const res = await fetch(url);
  check("missing token → 401", res.status === 401, { status: res.status });
}

// 3. Token for a different chatId — expect 401 (chat-token is
//    chatId-scoped; verifyChatToken cross-checks `claims.chatId`
//    against the URL path).
{
  const token = await mintChatToken(SIGNING_KEY, {
    userId: "spike-user",
    chatId: `${CHAT_ID}-other`,
    tenantId: "spike-tenant",
  });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  check("token for different chat → 401", res.status === 401, { status: res.status });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall get-messages smoke checks passed");
