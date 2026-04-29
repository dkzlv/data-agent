import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { createDbClient, schema } from "@data-agent/db";
import { sendEmail } from "@data-agent/shared";
import { readSecret, type Env } from "./env";

/**
 * Build a per-request Better Auth instance. Postgres connections are
 * created lazily and disposed when the request finishes — DOs and
 * Workers don't share long-lived state across requests.
 */
export async function createAuth(env: Env, ctx: ExecutionContext) {
  const dbUrl = await readSecret(env.CONTROL_PLANE_DB_URL);
  const secret = await readSecret(env.BETTER_AUTH_SECRET);

  const { db, client } = createDbClient({ url: dbUrl });
  // Hand the connection to the request lifecycle so it cleans up
  // after the response is fully sent. The previous implementation
  // closed via `Promise.resolve().then(...)` which fires on the very
  // next microtask — *before* better-auth's `auth.handler()` has a
  // chance to run its insert/query. That caused every magic-link
  // POST to 500 with "Failed query: insert into verification …".
  // Fix: close on a macrotask after a 5 s grace window, which is
  // longer than any auth round-trip and well within Workers' 30 s
  // request budget. `waitUntil` keeps the worker alive for the close
  // even after the response is sent.
  ctx.waitUntil(
    new Promise<void>((res) =>
      setTimeout(() => {
        client.end({ timeout: 1 }).catch(() => {});
        res();
      }, 5_000)
    )
  );

  const cfAccountId = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID ?? "";
  const cfApiToken = (env as unknown as { CF_API_TOKEN?: string }).CF_API_TOKEN ?? "";

  const opts: BetterAuthOptions = {
    secret,
    baseURL: env.API_URL,
    trustedOrigins: [env.APP_URL],
    advanced: {
      defaultCookieAttributes: {
        // Single-origin deployment (web + api-gateway both on
        // `data-agent.dkzlv.com`): the auth cookie can be host-only
        // and SameSite=Lax — the simplest, most-private setting.
        // No `domain` attribute means the cookie is scoped to the
        // exact host that set it (the gateway), and since web hits
        // the gateway via same-origin `/api/*` requests, the
        // browser sends it without any cross-site quirks.
        //
        // Earlier alpha used `Domain=.data-agent.dkzlv.com` to share
        // the cookie across the apex + `api.` subdomain, but Brave
        // Shields' ephemeral-storage partitioning treated the apex
        // ↔ subdomain hop as cross-site and silently dropped the
        // cookie on second-tab navigations, surfacing as a Chromium
        // `ERR_BLOCKED_BY_RESPONSE` "HTTP ERROR 403" net error page.
        // See decision #10 in AGENTS.md.
        sameSite: "lax",
        secure: env.API_URL.startsWith("https://"),
        httpOnly: true,
      },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
    }),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // Allow-list gate (per ops directive): during the closed
          // alpha we only deliver magic links to the configured
          // domain(s). Any other address gets a *silent* no-op —
          // we don't bounce, throw, or log the email itself, so an
          // attacker probing the form can't enumerate which
          // addresses are permitted vs. blocked. The signup page
          // shows the same "check your inbox" message regardless,
          // matching better-auth's standard UX.
          //
          // `ALLOWED_EMAIL_DOMAINS` is a comma-separated list of
          // suffixes (no @). Default is `indent.com`. Use `*` to
          // disable the gate (open beta).
          const raw = (env as unknown as { ALLOWED_EMAIL_DOMAINS?: string }).ALLOWED_EMAIL_DOMAINS;
          const allowed = (raw ?? "indent.com")
            .split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);
          const isOpen = allowed.includes("*");
          const domain = email.split("@")[1]?.toLowerCase() ?? "";
          const allowedThisEmail = isOpen || allowed.includes(domain);
          if (!allowedThisEmail) {
            // Intentionally a no-op. Log only the *domain*, never
            // the local-part, so audit/observability can detect
            // spray attempts without leaking PII.
            console.log("magic link suppressed (domain not allowlisted)", { domain });
            return;
          }
          const result = await sendEmail(
            {
              CF_ACCOUNT_ID: cfAccountId,
              CF_API_TOKEN: cfApiToken,
              EMAIL: env.EMAIL,
            },
            {
              from: "robot@data-agent.dkzlv.com",
              to: email,
              subject: "Your data-agent sign-in link",
              text: `Click to sign in:\n\n${url}\n\nThis link expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
            }
          );
          if (!result.ok) {
            // Log but don't throw — better-auth will still return 200
            // to the client, and the magic-link itself is recoverable
            // via wrangler tail in dev. Production must alert on this.
            console.error("[auth] sendEmail failed", { error: result.error });
          } else {
            console.log("[auth] magic link sent", {
              provider: result.provider,
              messageId: result.messageId,
              domain: email.split("@")[1]?.toLowerCase(),
            });
          }
        },
      }),
    ],
  };

  return betterAuth(opts);
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
