/**
 * Worker environment bindings. Mirror what's declared in wrangler.jsonc.
 *
 * Secrets Store bindings appear as `{ get(): Promise<string> }` at runtime,
 * but in `--remote` and dev they are flattened to plain strings via .dev.vars.
 * We type them as plain strings here and use `readSecret()` to handle both
 * shapes, keeping call-sites simple.
 */
export type SecretBinding = string | { get: () => Promise<string> };

export interface Env {
  // Vars
  APP_URL: string;
  API_URL: string;
  COOKIE_DOMAIN: string;
  CF_ACCOUNT_ID: string;

  // Secrets
  CONTROL_PLANE_DB_URL: SecretBinding;
  BETTER_AUTH_SECRET: SecretBinding;
  INTERNAL_JWT_SIGNING_KEY: SecretBinding;
  MASTER_ENCRYPTION_KEY: SecretBinding;
  CF_API_TOKEN?: SecretBinding;

  // R2
  ARTIFACTS: R2Bucket;

  // Service binding to chat-agent worker
  CHAT_AGENT: Fetcher;
}

const cache = new WeakMap<object, Map<string, string>>();
const stringCache = new Map<string, string>();

/** Read a Secrets Store binding or fall back to a plain string from .dev.vars. */
export async function readSecret(binding: SecretBinding, key = ""): Promise<string> {
  if (typeof binding === "string") {
    if (key) stringCache.set(key, binding);
    return binding;
  }
  // Cache resolved values to avoid hitting Secrets Store on every request.
  let perBindingCache = cache.get(binding);
  if (!perBindingCache) {
    perBindingCache = new Map();
    cache.set(binding, perBindingCache);
  }
  const cached = perBindingCache.get("v");
  if (cached !== undefined) return cached;
  const value = await binding.get();
  perBindingCache.set("v", value);
  return value;
}
