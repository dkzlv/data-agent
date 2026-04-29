import { routeAgentRequest } from "agents";
import type { Env } from "./env";
export { ChatAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Health check (handy for service-binding smoke tests from api-gateway)
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({
        ok: true,
        service: "chat-agent",
        time: new Date().toISOString(),
      });
    }

    // Route agent WS / HTTP requests by name (agents SDK expects /agents/<className>/<name>/...)
    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
