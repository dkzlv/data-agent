import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";

const API_URL =
  typeof window !== "undefined"
    ? // In browser, hit api-gateway through the env-injected URL.
      // In dev, both run on different ports; in prod they share a domain.
      ((window as unknown as { __ENV__?: { API_URL?: string } }).__ENV__?.API_URL ??
      "http://localhost:8787")
    : "http://localhost:8787";

export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [magicLinkClient()],
  fetchOptions: {
    credentials: "include",
  },
});

export type AuthClient = typeof authClient;
