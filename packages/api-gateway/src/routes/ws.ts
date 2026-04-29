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
import { mintChatToken } from "@data-agent/shared";
import { schema } from "@data-agent/db";
import { readSecret, type Env } from "../env";
import { requireSession, type RequestSession } from "../session";

type Vars = { session: RequestSession };

export const wsRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

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
  const [member] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .innerJoin(schema.chat, eq(schema.chat.id, schema.chatMember.chatId))
    .where(
      and(
        eq(schema.chatMember.chatId, chatId),
        eq(schema.chatMember.userId, user.id),
        eq(schema.chat.tenantId, tenantId)
      )
    )
    .limit(1);

  if (!member) {
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

  return c.env.CHAT_AGENT.fetch(fwdReq);
});
