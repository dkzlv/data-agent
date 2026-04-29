/**
 * Email sending helpers.
 *
 * Cloudflare Email Sending (Beta) does not yet expose a Worker binding
 * (as of 2026-04). We send via the REST API:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/send
 *
 * Domain `data-agent.dkzlv.com` is already onboarded with DKIM published.
 * Daily quota: 1000 messages.
 *
 * Auth uses CF_API_TOKEN from Secrets Store (or a dev token in .dev.vars).
 * If CF_API_TOKEN is empty, we log to stderr instead — useful for local
 * dev (the magic-link URL is visible in `wrangler tail`) and acceptable
 * for the alpha.
 */

export type SendEmailParams = {
  /** Sender address; must be on `data-agent.dkzlv.com`. */
  from: string;
  /** "Recipient <foo@bar.com>" or just "foo@bar.com". */
  to: string;
  subject: string;
  /** Plain-text body. HTML is optional below. */
  text: string;
  html?: string;
};

export type SendEmailEnv = {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN?: string;
};

export type SendEmailResult =
  | { ok: true; provider: "cloudflare" | "log" }
  | { ok: false; error: string };

const DEFAULT_FROM = "data-agent <noreply@data-agent.dkzlv.com>";

export async function sendEmail(
  env: SendEmailEnv,
  params: SendEmailParams
): Promise<SendEmailResult> {
  const from = params.from || DEFAULT_FROM;
  const token = env.CF_API_TOKEN?.trim();

  if (!token) {
    // Dev-mode fallback. Surfaces in `wrangler tail` so the magic-link URL is visible.
    console.warn(
      `[email/log] CF_API_TOKEN is unset; logging email instead of sending.\n` +
        `from: ${from}\nto: ${params.to}\nsubject: ${params.subject}\n\n${params.text}`
    );
    return { ok: true, provider: "log" };
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/send`;
  const body = {
    from,
    to: [params.to],
    subject: params.subject,
    text: params.text,
    ...(params.html ? { html: params.html } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    return { ok: false, error: `cloudflare email/send ${res.status}: ${text.slice(0, 500)}` };
  }
  return { ok: true, provider: "cloudflare" };
}
