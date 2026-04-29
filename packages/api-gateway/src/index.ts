import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createAuth } from "./auth";
import { chatsRouter } from "./routes/chats";
import { dbProfilesRouter } from "./routes/db-profiles";
import type { RequestSession } from "./session";
import type { Env } from "./env";

type Bindings = Env;
type Variables = {
  session?: RequestSession;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", logger());

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin") ?? c.env.APP_URL;
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

// WS upgrade route is mounted before the CRUD router so it takes precedence.
// Real impl in subtask e1a679.
api.get("/chats/:id/ws", (c) => c.json({ todo: "e1a679", id: c.req.param("id") }, 501));

api.route("/chats", chatsRouter);
api.route("/db-profiles", dbProfilesRouter);

app.route("/api", api);

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("api-gateway unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});

export default app satisfies ExportedHandler<Env>;
