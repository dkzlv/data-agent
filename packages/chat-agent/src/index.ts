import { routeAgentRequest } from "agents";
import { logEvent, truncateMessage, verifyChatToken } from "@data-agent/shared";
import { readSecret, type Env } from "./env";
export { ChatAgent } from "./agent";

/**
 * Defense-in-depth WS authentication.
 *
 * Even though the api-gateway always validates session + chat membership
 * before forwarding, the chat-agent worker is also exposed on its own
 * `*.workers.dev` URL. We refuse any WS upgrade that doesn't carry a
 * valid `Authorization: Bearer <chatToken>`.
 *
 * The token is HS256-signed with `INTERNAL_JWT_SIGNING_KEY` shared with
 * the api-gateway, scoped to a specific chatId, and short-lived (5min).
 *
 * For the spike harness and the existing healthcheck() RPC we still allow
 * unauthenticated calls — those go through `routePartykitRequest` but do
 * not trigger `onBeforeConnect` for non-WebSocket entrypoints. Once the
 * gateway is the only entry path we'll tighten this further.
 */
/**
 * Validate the per-request chat token. Used both for WS upgrades and for
 * HTTP fetches (artifact serving). The token can come via Authorization
 * header (gateway path) OR `?token=` query param (browser <img src> path,
 * since browsers can't set headers on those).
 */
/**
 * Validate the chat token AND, on success, return a Request augmented
 * with `x-data-agent-user-id` and `x-data-agent-tenant-id` headers
 * that are visible to the DO's `onConnect` / `onRequest` handlers.
 *
 * Returning a mutated Request to the agents SDK's onBeforeConnect /
 * onBeforeRequest is the supported way to forward auth-derived facts
 * into the DO without re-validating the token there.
 */
async function authenticateChatRequest(req: Request, env: Env): Promise<Response | Request | null> {
  const url = new URL(req.url);

  let token = "";
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    token = auth.slice("Bearer ".length).trim();
  } else {
    token = url.searchParams.get("token") ?? "";
  }
  if (!token) {
    return new Response("missing chat token", { status: 401 });
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const chatId = parts[2] ? decodeURIComponent(parts[2]) : "";
  if (!chatId) {
    return new Response("missing chatId in path", { status: 400 });
  }

  try {
    const signingKey = await readSecret(env.INTERNAL_JWT_SIGNING_KEY);
    const claims = await verifyChatToken(signingKey, token, { chatId });

    // Forward auth-derived identity to the DO via headers on a cloned
    // Request. We can't mutate the original Request's headers (immutable
    // on inbound), so a fresh Request copy is required.
    const headers = new Headers(req.headers);
    headers.set("x-data-agent-user-id", claims.userId);
    headers.set("x-data-agent-tenant-id", claims.tenantId);
    return new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      // Preserve WS upgrade specifics — Workers passes them on the
      // Request automatically and Request constructor copies them.
    });
  } catch (err) {
    logEvent({
      event: "chat.auth_failed",
      level: "warn",
      chatId,
      error: truncateMessage(err),
    });
    return new Response("invalid token", { status: 401 });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "chat-agent",
        time: new Date().toISOString(),
      });
    }

    // Route agent WS / HTTP requests by name. We validate the chat token
    // on BOTH WS upgrades (onBeforeConnect) and arbitrary HTTP requests
    // (onBeforeRequest). RPC `@callable()` calls go through the WS path
    // and inherit the WS upgrade authentication.
    const routed = await routeAgentRequest(request, env, {
      cors: true,
      // Returning a Request from these hooks forwards the (potentially
      // mutated) request into the DO. Returning a Response short-circuits
      // with that response. Returning undefined / null lets the SDK
      // forward the original request unchanged.
      onBeforeConnect: async (req) => {
        const result = await authenticateChatRequest(req, env);
        return result ?? undefined;
      },
      onBeforeRequest: async (req) => {
        const result = await authenticateChatRequest(req, env);
        return result ?? undefined;
      },
    });
    if (routed) return routed;

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
