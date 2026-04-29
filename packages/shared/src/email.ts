/**
 * Email sending helpers.
 *
 * Two transports, in priority order:
 *
 * 1. **Cloudflare Email Sending Workers binding** (`send_email` with
 *    `remote: true`). The Worker calls `env.EMAIL.send({...})` and
 *    Cloudflare delivers via DKIM-signed SMTP from the configured
 *    sender domain. No API token needed — the binding's permissions
 *    are scoped at deploy time. This is the production path.
 *
 * 2. **REST API fallback** —
 *    `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`.
 *    Used when no binding is provided (e.g. from a script outside
 *    the worker). Requires `CF_API_TOKEN` with `Email Sending: Edit`
 *    permission.
 *
 * If both are absent we log to stderr so dev shows the magic-link URL
 * via `wrangler tail`.
 *
 * Sender domain (`dkzlv.com`) must be onboarded via dash → Email
 * Sending. Daily quota: 1000 messages on the free tier.
 */

export type SendEmailParams = {
  /** Sender address; domain must be onboarded in Email Sending. */
  from: string;
  /** "foo@bar.com" — use a single recipient for magic links. */
  to: string;
  subject: string;
  /** Plain-text body. HTML is optional. */
  text: string;
  html?: string;
};

export type EmailBinding = {
  send(message: {
    to: string | string[];
    from: string | { address: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
};

export type SendEmailEnv = {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN?: string;
  EMAIL?: EmailBinding;
};

export type SendEmailResult =
  | { ok: true; provider: "binding" | "rest" | "log"; messageId?: string }
  | { ok: false; error: string };

const DEFAULT_FROM = "data-agent <robot@dkzlv.com>";

export async function sendEmail(
  env: SendEmailEnv,
  params: SendEmailParams
): Promise<SendEmailResult> {
  const from = params.from || DEFAULT_FROM;

  // 1. Prefer the binding when present.
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    try {
      const res = await env.EMAIL.send({
        to: params.to,
        from,
        subject: params.subject,
        text: params.text,
        ...(params.html ? { html: params.html } : {}),
      });
      return { ok: true, provider: "binding", messageId: res.messageId };
    } catch (err) {
      // Surface binding errors so callers / observability can catch
      // misconfiguration — silent dev fallback only when there's no
      // binding at all.
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `email-binding: ${msg}` };
    }
  }

  // 2. REST fallback.
  const token = env.CF_API_TOKEN?.trim();
  if (token) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`;
    const body = {
      from,
      to: params.to,
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
      return {
        ok: false,
        error: `cloudflare email/sending/send ${res.status}: ${text.slice(0, 500)}`,
      };
    }
    return { ok: true, provider: "rest" };
  }

  // 3. Dev/log fallback.
  console.warn(
    `[email/log] no EMAIL binding and no CF_API_TOKEN; logging email instead of sending.\n` +
      `from: ${from}\nto: ${params.to}\nsubject: ${params.subject}\n\n${params.text}`
  );
  return { ok: true, provider: "log" };
}
