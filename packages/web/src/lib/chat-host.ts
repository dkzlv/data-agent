/**
 * Resolve the WebSocket host for the api-gateway from the runtime env.
 * `useAgent` accepts `host` as a bare host (no protocol). In production
 * this is `api.data-agent.dkzlv.com`; in dev it's the api-gateway's
 * wrangler dev port.
 *
 * The api-gateway proxies WS upgrades to the chat-agent service binding
 * via `/api/chats/:chatId/ws`, validating the user's better-auth cookie
 * and minting a per-chat token before forwarding.
 */
export function getChatHost(): string {
  if (typeof window === "undefined") return "localhost:8787";
  const env = (window as unknown as { __ENV__?: { API_URL?: string } }).__ENV__;
  const url = env?.API_URL ?? "http://localhost:8787";
  try {
    return new URL(url).host;
  } catch {
    return "localhost:8787";
  }
}
