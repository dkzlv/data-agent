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
  /**
   * Comma-separated list of email-domain suffixes (no `@`) allowed
   * to receive magic-link sign-ins. Anything else is silently
   * dropped from `sendMagicLink` so attackers can't enumerate which
   * domains are permitted. Use `*` to disable the gate.
   * Defaults to `indent.com` if unset.
   */
  ALLOWED_EMAIL_DOMAINS?: string;
  /**
   * Comma-separated list of additional origins allowed for
   * credentialed CORS requests beyond `APP_URL`. Localhost is
   * always allowed (dev convenience). Closed-list to prevent
   * cross-origin credential leakage (c87874 finding).
   */
  CORS_EXTRA_ORIGINS?: string;

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

  /**
   * Cloudflare Email Sending binding. Configured with `remote: true`
   * in wrangler.jsonc so it routes through the new Email Sending
   * product (not the older Email Routing send pathway). Sender
   * domain (`dkzlv.com`) must be onboarded via dash → Email Sending.
   */
  EMAIL: {
    send(message: {
      to: string | string[];
      from: string | { address: string; name?: string };
      subject: string;
      text?: string;
      html?: string;
      replyTo?: string | { address: string; name?: string };
    }): Promise<{ messageId?: string }>;
  };
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
