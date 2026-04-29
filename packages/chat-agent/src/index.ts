import { routeAgentRequest } from "agents";
import { verifyChatToken } from "@data-agent/shared";
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
async function authenticateWsUpgrade(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  // Browsers can't set headers on `new WebSocket(...)`, so we accept the
  // token via the `?token=` query param as well as the Authorization
  // header. The api-gateway always uses the header path.
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

  // Pull chatId from the URL: /agents/ChatAgent/<chatId>
  // (The `agents` SDK lowercases class names — class "ChatAgent" → "chat-agent".)
  const parts = url.pathname.split("/").filter(Boolean);
  // parts[0]="agents", parts[1]=<class kebab>, parts[2]=<chatId>
  const chatId = parts[2] ? decodeURIComponent(parts[2]) : "";
  if (!chatId) {
    return new Response("missing chatId in path", { status: 400 });
  }

  try {
    const signingKey = await readSecret(env.INTERNAL_JWT_SIGNING_KEY);
    await verifyChatToken(signingKey, token, { chatId });
    return null;
  } catch (err) {
    console.warn("ws auth failed", { chatId, err: (err as Error).message });
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

    // Route agent WS / HTTP requests by name.
    // `onBeforeConnect` runs only for WS upgrades — HTTP RPC calls are not
    // gated here (they have their own per-method `@callable()` policy).
    const routed = await routeAgentRequest(request, env, {
      cors: true,
      onBeforeConnect: async (req) => {
        const reject = await authenticateWsUpgrade(req, env);
        return reject ?? undefined;
      },
    });
    if (routed) return routed;

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
