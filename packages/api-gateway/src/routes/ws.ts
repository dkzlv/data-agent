/**
 * WS upgrade route — `/api/chats/:id/ws`.
 *
 * Flow:
 *   1. Validate the user's session cookie (Better Auth).
 *   2. Verify the user is a member of the requested chat.
 *   3. Mint a short-lived chat token (HS256, scoped to chatId+userId+tenantId).
 *   4. Rewrite the URL to the agents SDK shape `/agents/ChatAgent/<chatId>`
 *      and forward the upgrade to the chat-agent service binding with the
 *      token in the `Authorization` header.
 *
 * The chat-agent worker re-validates the token in its `onBeforeConnect`
 * hook, so this gateway is the canonical authentication point but the DO
 * still enforces. This is defense-in-depth: anyone who can call the
 * chat-agent worker directly via its workers.dev URL is still rejected
 * unless they hold a valid token.
 */
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { logEvent, mintChatToken, truncateMessage } from "@data-agent/shared";
import { schema, type Database } from "@data-agent/db";
import { writeAudit } from "../audit";
import { readSecret, type Env } from "../env";
import { requireSession, type RequestSession } from "../session";

type Vars = { session: RequestSession };

export const wsRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Membership gate shared by every chat-scoped route in this file. The
 * join through `chat` enforces that the chat belongs to the current
 * tenant — a leaked chatId from a different workspace cannot be used
 * to mint a token here. Earlier each route inlined this query; the
 * fourth copy (the `/get-messages` proxy) prompted a tiny extraction.
 */
async function isChatMember(
  db: Database,
  args: { chatId: string; userId: string; tenantId: string }
): Promise<boolean> {
  const [row] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .innerJoin(schema.chat, eq(schema.chat.id, schema.chatMember.chatId))
    .where(
      and(
        eq(schema.chatMember.chatId, args.chatId),
        eq(schema.chatMember.userId, args.userId),
        eq(schema.chat.tenantId, args.tenantId)
      )
    )
    .limit(1);
  return !!row;
}

wsRouter.get("/chats/:id/ws", requireSession(), async (c) => {
  // The browser must be opening a WebSocket — reject plain GETs so we don't
  // accidentally leak tokens via curl probes.
  const upgrade = c.req.header("upgrade")?.toLowerCase();
  if (upgrade !== "websocket") {
    return c.json({ error: "expected_websocket_upgrade" }, 400);
  }

  const chatId = c.req.param("id");
  const { user, tenantId, db } = c.var.session;

  // Membership check (also enforces tenant ownership of the chat).
  if (!(await isChatMember(db, { chatId, userId: user.id, tenantId }))) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Mint chat token. 5 minute TTL is plenty — the DO trusts the connection
  // for its lifetime once upgraded. If the connection drops the client
  // re-fetches a fresh token.
  const signingKey = await readSecret(c.env.INTERNAL_JWT_SIGNING_KEY);
  const token = await mintChatToken(signingKey, {
    userId: user.id,
    chatId,
    tenantId,
  });

  // Rewrite to agents-sdk URL. The agents SDK kebab-cases class names, so
  // `ChatAgent` is addressed as `/agents/chat-agent/<chatId>`. We preserve
  // any query string the client passed (the SDK uses `?_pk=` etc.).
  const orig = new URL(c.req.url);
  const forwardUrl = new URL(
    `/agents/chat-agent/${encodeURIComponent(chatId)}${orig.search}`,
    orig
  );

  // Clone headers and inject auth. We cannot reuse `c.req.raw` directly
  // because Hono normalizes the URL — the upstream needs the rewritten one.
  const fwdHeaders = new Headers(c.req.raw.headers);
  fwdHeaders.set("Authorization", `Bearer ${token}`);
  // Drop the cookie before forwarding — the chat-agent worker should never
  // see it (no need, and minimizes blast radius if it ever logs headers).
  fwdHeaders.delete("cookie");

  const fwdReq = new Request(forwardUrl, {
    method: c.req.raw.method,
    headers: fwdHeaders,
    // WebSocket upgrades have no body; explicitly null to avoid runtime
    // complaining about un-passable streams.
    body: null,
  });

  // Best-effort audit — never block the upgrade. We log only the
  // *intent to connect*; the chat-agent itself logs join/leave events
  // for presence in its own DO storage (not control-plane audit).
  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId,
      action: "chat.ws.connect",
      target: chatId,
    })
  );

  // Streaming-debug observability: log the upgrade hand-off so we
  // can correlate gateway-side reverse-proxy timing with the
  // chat-agent's `chat.ws.connect`. If the upstream call ever
  // throws (service binding error), the catch block logs the
  // failure too — currently invisible to the user.
  logEvent({
    event: "ws.upgrade",
    chatId,
    userId: user.id,
    tenantId,
    cfRay: c.req.header("cf-ray") ?? null,
  });

  try {
    const upstream = await c.env.CHAT_AGENT.fetch(fwdReq);
    logEvent({
      event: "ws.upgrade_response",
      chatId,
      userId: user.id,
      status: upstream.status,
      // 101 means the upgrade succeeded. Anything else means the
      // chat-agent rejected the WS (auth fail, route miss).
      upgraded: upstream.status === 101,
    });
    return upstream;
  } catch (err) {
    logEvent({
      event: "ws.upgrade_failed",
      level: "error",
      chatId,
      userId: user.id,
      error: truncateMessage(err),
    });
    throw err;
  }
});

/**
 * Initial messages proxy — `GET /api/chats/:id/ws/get-messages`.
 *
 * The `@cloudflare/ai-chat` React hook fetches this URL on mount —
 * it builds it by swapping `wss://` → `https://` on the WS URL and
 * appending `/get-messages`. Without this route the request 404s,
 * the SDK logs a warning, falls back to `[]` initial messages, and
 * the user sees an empty chat (history only re-appears once the
 * server's `cf_agent_chat_messages` snapshot lands over the WS).
 *
 * Think serves the actual `/get-messages` HTTP handler itself
 * inside the DO (think.js:1010-1015 returns `this.messages`); we
 * just need a thin authenticated reverse-proxy in front of it,
 * mirroring the WS upgrade route's auth model.
 *
 * Read-only — no audit row. Fires on every chat load and twice on
 * any WS reconnect; auditing every call would balloon the audit_log.
 */
wsRouter.get("/chats/:id/ws/get-messages", requireSession(), async (c) => {
  const chatId = c.req.param("id");
  const { user, tenantId, db } = c.var.session;

  if (!(await isChatMember(db, { chatId, userId: user.id, tenantId }))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const signingKey = await readSecret(c.env.INTERNAL_JWT_SIGNING_KEY);
  const token = await mintChatToken(signingKey, {
    userId: user.id,
    chatId,
    tenantId,
  });

  const orig = new URL(c.req.url);
  const forwardUrl = new URL(
    `/agents/chat-agent/${encodeURIComponent(chatId)}/get-messages${orig.search}`,
    orig
  );
  const fwdHeaders = new Headers(c.req.raw.headers);
  fwdHeaders.set("Authorization", `Bearer ${token}`);
  fwdHeaders.delete("cookie");
  const fwdReq = new Request(forwardUrl, {
    method: "GET",
    headers: fwdHeaders,
    body: null,
  });
  return c.env.CHAT_AGENT.fetch(fwdReq);
});

/**
 * Artifact list — `GET /api/chats/:id/artifacts`.
 *
 * Returns the chat's artifact manifest (newest first). Used by the
 * workspace sidebar in the chat UI.
 */
wsRouter.get("/chats/:id/artifacts", requireSession(), async (c) => {
  const chatId = c.req.param("id");
  const { user, tenantId, db } = c.var.session;

  if (!(await isChatMember(db, { chatId, userId: user.id, tenantId }))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const signingKey = await readSecret(c.env.INTERNAL_JWT_SIGNING_KEY);
  const token = await mintChatToken(signingKey, { userId: user.id, chatId, tenantId });

  // Forward to chat-agent's manifest endpoint.
  const orig = new URL(c.req.url);
  const forwardUrl = new URL(`/agents/chat-agent/${encodeURIComponent(chatId)}/artifacts`, orig);
  const fwdHeaders = new Headers(c.req.raw.headers);
  fwdHeaders.set("Authorization", `Bearer ${token}`);
  fwdHeaders.delete("cookie");
  const fwdReq = new Request(forwardUrl, { method: "GET", headers: fwdHeaders, body: null });
  return c.env.CHAT_AGENT.fetch(fwdReq);
});

/**
 * Artifact bytes proxy — `GET /api/chats/:id/artifacts/:artifactId`.
 *
 * Validates session + chat membership, mints a chat token, and forwards
 * to the chat-agent worker which serves the bytes from R2-backed
 * Workspace storage. Same auth pattern as the WS upgrade route.
 *
 * Browsers can't set custom headers on `<img src>` / `fetch()` from
 * cross-origin (well, `fetch` can — but `img` cannot), so we *also*
 * accept `?token=` here for `<img src>` use cases.
 */
wsRouter.get("/chats/:id/artifacts/:artifactId", requireSession(), async (c) => {
  const chatId = c.req.param("id");
  const artifactId = c.req.param("artifactId");
  const { user, tenantId, db } = c.var.session;

  if (!(await isChatMember(db, { chatId, userId: user.id, tenantId }))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const signingKey = await readSecret(c.env.INTERNAL_JWT_SIGNING_KEY);
  const token = await mintChatToken(signingKey, { userId: user.id, chatId, tenantId });

  const orig = new URL(c.req.url);
  const forwardUrl = new URL(
    `/agents/chat-agent/${encodeURIComponent(chatId)}/artifacts/${encodeURIComponent(artifactId)}`,
    orig
  );
  const fwdHeaders = new Headers(c.req.raw.headers);
  fwdHeaders.set("Authorization", `Bearer ${token}`);
  fwdHeaders.delete("cookie");

  const fwdReq = new Request(forwardUrl, {
    method: "GET",
    headers: fwdHeaders,
    body: null,
  });

  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId,
      action: "artifact.read",
      target: artifactId,
    })
  );

  return c.env.CHAT_AGENT.fetch(fwdReq);
});
