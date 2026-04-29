import { Hono } from "hono";
import { cors } from "hono/cors";
import { logEvent, truncateMessage } from "@data-agent/shared";
import { createAuth } from "./auth";
import { auditRouter } from "./routes/audit";
import { chatsRouter } from "./routes/chats";
import { dbProfilesRouter } from "./routes/db-profiles";
import { wsRouter } from "./routes/ws";
import type { RequestSession } from "./session";
import type { Env } from "./env";

type Bindings = Env;
type Variables = {
  session?: RequestSession;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Structured per-request span (subtask 9fa055). Replaces hono's
 * dev-friendly `logger()` with a single JSON line per request that
 * Workers Logs can index by any field. We emit AFTER `next()` so we
 * can include the response status. WS upgrades skip the span (they
 * never resolve `next()` to a normal Response — see wsRouter).
 *
 * Fields: method, path, status, durationMs, userId?, tenantId?,
 * sessionId?, ua?, cfRay (request id for cross-worker correlation).
 *
 * Hot paths like `/healthz` are still logged because the request
 * volume is tiny and "is healthz green?" is a useful filter.
 */
app.use("*", async (c, next) => {
  const startedAt = Date.now();
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  const cfRay = c.req.header("cf-ray") ?? null;
  try {
    await next();
  } catch (err) {
    // Hono's onError handler will set the response, but we still
    // want the span for failed requests.
    logEvent({
      event: "api.request",
      level: "error",
      method,
      path,
      status: 500,
      durationMs: Date.now() - startedAt,
      cfRay,
      error: truncateMessage(err),
    });
    throw err;
  }
  const session = c.get("session");
  logEvent({
    event: "api.request",
    method,
    path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
    cfRay,
    // Most public endpoints (auth, healthz) won't have a session
    // attached — emit `null` rather than skip the span so a query
    // for "anonymous traffic" still works.
    userId: session?.user?.id ?? null,
    tenantId: session?.tenantId ?? null,
  });
});

app.use("/api/*", async (c, next) => {
  // Closed-list CORS (subtask c87874 finding).
  //
  // Earlier code reflected the request's `Origin` header back as
  // `Access-Control-Allow-Origin` with `credentials: true` — that
  // lets any cross-origin attacker include the user's session
  // cookie in their fetches. Now we only allow:
  //   - the configured APP_URL (production / alpha)
  //   - localhost dev hosts (so `pnpm --filter web dev` works)
  //   - explicit `CORS_EXTRA_ORIGINS` list for staging mirrors
  //
  // Anything else falls back to APP_URL, which the browser will
  // then reject (preventing credential-leaking flows).
  const requestOrigin = c.req.header("origin");
  const allowed = new Set<string>([c.env.APP_URL]);
  for (const extra of (c.env.CORS_EXTRA_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) allowed.add(trimmed);
  }
  const isLocalhost =
    requestOrigin?.startsWith("http://localhost:") ||
    requestOrigin?.startsWith("http://127.0.0.1:");
  const origin =
    requestOrigin && (allowed.has(requestOrigin) || isLocalhost) ? requestOrigin : c.env.APP_URL;
  return cors({
    origin,
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    maxAge: 86400,
  })(c, next);
});

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    service: "api-gateway",
    time: new Date().toISOString(),
  })
);

// Better Auth handler — handles /api/auth/sign-in/magic-link, /api/auth/get-session, etc.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const auth = await createAuth(c.env, c.executionCtx);
  return auth.handler(c.req.raw);
});

// API surface — handlers land in later subtasks.
const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// WS upgrade route is mounted before the CRUD router so the `/:id/ws` path
// is matched by the upgrade handler instead of the chat-by-id GET.
api.route("/", wsRouter);

api.route("/chats", chatsRouter);
api.route("/db-profiles", dbProfilesRouter);
api.route("/audit", auditRouter);

app.route("/api", api);

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
app.onError((err, c) => {
  // Don't log here — the per-request middleware already records the
  // span as an error span (status 500). We just translate the error
  // into the response body.
  return c.json({ error: "internal error", message: truncateMessage(err) }, 500);
});

export default app satisfies ExportedHandler<Env>;
