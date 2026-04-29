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
  // Hand the connection to the request lifecycle so it cleans up.
  ctx.waitUntil(Promise.resolve().then(() => client.end({ timeout: 1 }).catch(() => {})));

  const cfAccountId = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID ?? "";
  const cfApiToken = (env as unknown as { CF_API_TOKEN?: string }).CF_API_TOKEN ?? "";

  const opts: BetterAuthOptions = {
    secret,
    baseURL: env.API_URL,
    trustedOrigins: [env.APP_URL],
    advanced: {
      defaultCookieAttributes: {
        // The web app and api-gateway live on different hosts during
        // alpha (different *.workers.dev subdomains). Cross-origin
        // cookie sharing requires SameSite=None + Secure. When we move
        // both to subdomains of data-agent.dkzlv.com (same registrable
        // domain), we'll downgrade to "lax" and set `domain: ".dkzlv.com"`.
        sameSite: env.COOKIE_DOMAIN.startsWith(".") ? "lax" : "none",
        secure: env.API_URL.startsWith("https://"),
        httpOnly: true,
        // Only set explicit Domain when COOKIE_DOMAIN is a leading-dot
        // value (registrable domain). Otherwise leave the cookie
        // host-only on the api-gateway origin.
        domain: env.COOKIE_DOMAIN.startsWith(".") ? env.COOKIE_DOMAIN : undefined,
      },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
    }),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(
            { CF_ACCOUNT_ID: cfAccountId, CF_API_TOKEN: cfApiToken },
            {
              from: "data-agent <noreply@data-agent.dkzlv.com>",
              to: email,
              subject: "Your data-agent sign-in link",
              text: `Click to sign in:\n\n${url}\n\nThis link expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`,
            }
          );
        },
      }),
    ],
  };

  return betterAuth(opts);
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
