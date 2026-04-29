import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Env } from "./env";

type Bindings = Env;
type Variables = {
  // Populated by middleware in later subtasks (auth session, etc.)
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

// API surface — handlers land in later subtasks.
const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

api.get("/chats", (c) => c.json({ todo: "b1f5fd" }, 501));
api.post("/chats", (c) => c.json({ todo: "b1f5fd" }, 501));
api.get("/chats/:id", (c) => c.json({ todo: "b1f5fd", id: c.req.param("id") }, 501));
api.get("/chats/:id/ws", (c) => c.json({ todo: "e1a679", id: c.req.param("id") }, 501));

api.get("/db-profiles", (c) => c.json({ todo: "b75305" }, 501));
api.post("/db-profiles", (c) => c.json({ todo: "b75305" }, 501));

app.route("/api", api);

app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error("api-gateway unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});

export default app satisfies ExportedHandler<Env>;
