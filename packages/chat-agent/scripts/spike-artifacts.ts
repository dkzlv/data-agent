/**
 * Subtask 5038e4 spike: chart + artifact tool providers end-to-end.
 *
 *   1. Create test fixtures (no DB needed — no db.* tools used).
 *   2. Call ChatAgent.artifactToolsSmoke() — saves a bar chart + a
 *      markdown artifact, returns manifest summary.
 *   3. HTTP-fetch each artifact via the chat-agent worker URL with the
 *      chat token and verify the bytes match what we expect.
 *   4. Cleanup.
 *
 * Run:
 *   pnpm --filter @data-agent/chat-agent exec tsx scripts/spike-artifacts.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AgentClient } from "agents/client";
import { createDbClient, schema } from "@data-agent/db";
import { mintChatToken } from "@data-agent/shared";

function loadDevVar(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const path of candidates) {
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(new RegExp(`^${name}="?([^"\\n]+)"?`, "m"));
      if (m) return m[1]!;
    } catch {
      // try next
    }
  }
  throw new Error(`${name} not in env or .dev.vars`);
}

const ENDPOINT = process.env.SPIKE_ENDPOINT ?? "data-agent-chat-agent.dkzlv.workers.dev";
const SIGNING_KEY = loadDevVar("INTERNAL_JWT_SIGNING_KEY");
const DB_URL = loadDevVar("CONTROL_PLANE_DB_URL");

const stamp = Date.now();
const TEST_USER_ID = `spike-art-user-${stamp}`;
const TEST_TENANT_ID = `spike-art-tenant-${stamp}`;
const TEST_CHAT_ID = `spike-art-chat-${stamp}`;

interface RPC {
  artifactToolsSmoke(): Promise<{
    chart: { id: string; url: string; chartType?: string };
    file: { id: string; url: string; name: string };
    list: { count: number; first?: { name: string; kind: string } };
  }>;
}

async function setup() {
  const { db, client } = createDbClient({ url: DB_URL, max: 2 });
  try {
    await db.insert(schema.user).values({
      id: TEST_USER_ID,
      email: `${TEST_USER_ID}@spike.test`,
      emailVerified: true,
      name: "Spike",
    });
    await db.insert(schema.tenant).values({
      id: TEST_TENANT_ID,
      name: "Spike artifact tenant",
      ownerUserId: TEST_USER_ID,
    });
    await db.insert(schema.tenantMember).values({
      tenantId: TEST_TENANT_ID,
      userId: TEST_USER_ID,
      role: "owner",
    });
    await db.insert(schema.chat).values({
      id: TEST_CHAT_ID,
      tenantId: TEST_TENANT_ID,
      title: "spike-artifacts",
      createdBy: TEST_USER_ID,
    });
    await db.insert(schema.chatMember).values({
      chatId: TEST_CHAT_ID,
      userId: TEST_USER_ID,
      role: "owner",
    });
    console.log("  ✓ fixtures inserted: chat=" + TEST_CHAT_ID);
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function cleanup() {
  const { db, client } = createDbClient({ url: DB_URL, max: 2 });
  try {
    await db.delete(schema.chatMember).where(eq(schema.chatMember.chatId, TEST_CHAT_ID));
    await db.delete(schema.chat).where(eq(schema.chat.id, TEST_CHAT_ID));
    await db.delete(schema.tenantMember).where(eq(schema.tenantMember.userId, TEST_USER_ID));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, TEST_TENANT_ID));
    await db.delete(schema.user).where(eq(schema.user.id, TEST_USER_ID));
    console.log("  ✓ cleanup complete");
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function callSmoke() {
  const token = await mintChatToken(SIGNING_KEY, {
    userId: TEST_USER_ID,
    chatId: TEST_CHAT_ID,
    tenantId: TEST_TENANT_ID,
  });
  const c = new AgentClient<RPC>({
    host: ENDPOINT,
    agent: "ChatAgent",
    name: TEST_CHAT_ID,
    query: { token },
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("connect timeout")), 10_000);
    c.addEventListener("open", () => {
      clearTimeout(t);
      res();
    });
    c.addEventListener("error", () => {
      clearTimeout(t);
      rej(new Error("ws error"));
    });
  });
  try {
    return { result: await c.call("artifactToolsSmoke", []), token };
  } finally {
    c.close();
  }
}

async function fetchArtifact(
  token: string,
  url: string
): Promise<{ ok: boolean; mime: string | null; body: string }> {
  // The URL the smoke RPC returns is `/api/chats/<chatId>/artifacts/<id>`,
  // which lives behind the api-gateway. The gateway isn't deployed yet,
  // so we fetch directly from the chat-agent worker using its own URL
  // shape: /agents/chat-agent/<chatId>/artifacts/<id>?token=…
  const m = url.match(/\/api\/chats\/([^/]+)\/artifacts\/([^/]+)/);
  if (!m) throw new Error("bad artifact URL: " + url);
  const direct = `https://${ENDPOINT}/agents/chat-agent/${m[1]}/artifacts/${m[2]}?token=${encodeURIComponent(token)}`;
  const res = await fetch(direct);
  return {
    ok: res.ok,
    mime: res.headers.get("content-type"),
    body: await res.text(),
  };
}

async function main() {
  console.log(`spike-artifacts: chat=${TEST_CHAT_ID}\n`);
  console.log("[1/4] Setting up control-plane fixtures…");
  await setup();
  try {
    console.log("\n[2/4] Calling ChatAgent.artifactToolsSmoke() …");
    const { result, token } = await callSmoke();
    console.log("  ✓ chart  :", result.chart);
    console.log("  ✓ file   :", result.file);
    console.log("  ✓ list   :", result.list);
    if (result.list.count !== 2) {
      throw new Error("expected 2 artifacts in manifest, got " + result.list.count);
    }

    console.log("\n[3/4] HTTP-fetching artifact bytes via /agents/chat-agent/…/artifacts/<id>…");
    const chartFetch = await fetchArtifact(token, result.chart.url);
    if (!chartFetch.ok) throw new Error("chart artifact fetch failed");
    if (!chartFetch.mime?.includes("vegalite")) {
      throw new Error("chart mime should be vegalite, got " + chartFetch.mime);
    }
    const spec = JSON.parse(chartFetch.body) as { mark?: unknown; encoding?: unknown };
    if (spec.mark !== "bar")
      throw new Error("chart mark should be 'bar', got " + JSON.stringify(spec.mark));
    if (!spec.encoding) throw new Error("chart spec missing encoding");
    console.log("  ✓ chart spec parsed, mark=bar");

    const fileFetch = await fetchArtifact(token, result.file.url);
    if (!fileFetch.ok) throw new Error("file artifact fetch failed");
    if (!fileFetch.body.includes("# Hello")) throw new Error("file artifact body wrong");
    console.log("  ✓ markdown artifact body matches");

    console.log("\n[4/4] Cleanup…");
  } finally {
    await cleanup();
  }
  console.log("\n✓ chart.* + artifact.* tools work end-to-end");
}

main().catch(async (e) => {
  console.error("\n✗ spike-artifacts failed:", e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
