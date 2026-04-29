import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "@data-agent/db";
import { writeAudit } from "../audit";
import type { Env } from "../env";
import { requireSession, type RequestSession } from "../session";

type Vars = { session: RequestSession };

const newChatSchema = z.object({
  title: z.string().trim().min(1).max(200).default("Untitled chat"),
  dbProfileId: z.string().uuid().optional(),
});

const patchChatSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  dbProfileId: z.string().uuid().nullable().optional(),
  archive: z.boolean().optional(),
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "participant"]).default("participant"),
});

export const chatsRouter = new Hono<{ Bindings: Env; Variables: Vars }>();

chatsRouter.use("*", requireSession());

/** List chats the current user is a member of, latest activity first. */
chatsRouter.get("/", async (c) => {
  const { user, tenantId, db } = c.var.session;

  const rows = await db
    .select({
      id: schema.chat.id,
      title: schema.chat.title,
      dbProfileId: schema.chat.dbProfileId,
      createdAt: schema.chat.createdAt,
      updatedAt: schema.chat.updatedAt,
      archivedAt: schema.chat.archivedAt,
    })
    .from(schema.chat)
    .innerJoin(schema.chatMember, eq(schema.chatMember.chatId, schema.chat.id))
    .where(
      and(
        eq(schema.chat.tenantId, tenantId),
        eq(schema.chatMember.userId, user.id),
        isNull(schema.chat.archivedAt)
      )
    )
    .orderBy(desc(schema.chat.updatedAt));

  return c.json({ chats: rows });
});

/** Create a chat; creator is owner. */
chatsRouter.post("/", async (c) => {
  const { user, tenantId, db } = c.var.session;
  const body = newChatSchema.parse(await c.req.json().catch(() => ({})));

  // Verify the dbProfile (if any) belongs to this tenant
  if (body.dbProfileId) {
    const [profile] = await db
      .select({ id: schema.dbProfile.id })
      .from(schema.dbProfile)
      .where(
        and(
          eq(schema.dbProfile.id, body.dbProfileId),
          eq(schema.dbProfile.tenantId, tenantId),
          isNull(schema.dbProfile.deletedAt)
        )
      )
      .limit(1);
    if (!profile) return c.json({ error: "db_profile_not_found" }, 400);
  }

  const id = crypto.randomUUID();
  const [chat] = await db
    .insert(schema.chat)
    .values({
      id,
      tenantId,
      title: body.title,
      dbProfileId: body.dbProfileId ?? null,
      createdBy: user.id,
    })
    .returning();

  await db.insert(schema.chatMember).values({
    chatId: id,
    userId: user.id,
    role: "owner",
  });

  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId: id,
      action: "chat.create",
      target: id,
      payload: { title: body.title, dbProfileId: body.dbProfileId ?? null },
    })
  );

  return c.json({ chat }, 201);
});

/** Get chat metadata + members. */
chatsRouter.get("/:id", async (c) => {
  const { user, tenantId, db } = c.var.session;
  const id = c.req.param("id");

  const [chat] = await db
    .select()
    .from(schema.chat)
    .where(and(eq(schema.chat.id, id), eq(schema.chat.tenantId, tenantId)))
    .limit(1);
  if (!chat) return c.json({ error: "not_found" }, 404);

  // Membership check
  const [me] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, user.id)))
    .limit(1);
  if (!me) return c.json({ error: "forbidden" }, 403);

  const members = await db
    .select({
      userId: schema.chatMember.userId,
      role: schema.chatMember.role,
      addedAt: schema.chatMember.addedAt,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.chatMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.chatMember.userId))
    .where(eq(schema.chatMember.chatId, id));

  return c.json({ chat, members, myRole: me.role });
});

/** Patch — rename / change profile / archive. */
chatsRouter.patch("/:id", async (c) => {
  const { user, tenantId, db } = c.var.session;
  const id = c.req.param("id");
  const body = patchChatSchema.parse(await c.req.json());

  const [me] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, user.id)))
    .limit(1);
  if (!me) return c.json({ error: "forbidden" }, 403);
  if (body.archive !== undefined && me.role !== "owner") {
    return c.json({ error: "owner_only" }, 403);
  }

  type Patch = Partial<{
    title: string;
    dbProfileId: string | null;
    archivedAt: Date | null;
    updatedAt: Date;
  }>;
  const patch: Patch = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.dbProfileId !== undefined) patch.dbProfileId = body.dbProfileId;
  if (body.archive === true) patch.archivedAt = new Date();
  if (body.archive === false) patch.archivedAt = null;
  patch.updatedAt = new Date();

  const [updated] = await db
    .update(schema.chat)
    .set(patch)
    .where(and(eq(schema.chat.id, id), eq(schema.chat.tenantId, tenantId)))
    .returning();
  if (!updated) return c.json({ error: "not_found" }, 404);

  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId: id,
      action: body.archive === true ? "chat.archive" : "chat.update",
      target: id,
      payload: { changes: body },
    })
  );

  return c.json({ chat: updated });
});

/** Add a tenant member to the chat. */
chatsRouter.post("/:id/members", async (c) => {
  const { user, tenantId, db } = c.var.session;
  const id = c.req.param("id");
  const body = addMemberSchema.parse(await c.req.json());

  const [me] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, user.id)))
    .limit(1);
  if (!me || me.role !== "owner") return c.json({ error: "owner_only" }, 403);

  // Verify the new member is in the same tenant
  const [member] = await db
    .select({ userId: schema.tenantMember.userId })
    .from(schema.tenantMember)
    .where(
      and(eq(schema.tenantMember.tenantId, tenantId), eq(schema.tenantMember.userId, body.userId))
    )
    .limit(1);
  if (!member) return c.json({ error: "user_not_in_tenant" }, 400);

  await db
    .insert(schema.chatMember)
    .values({ chatId: id, userId: body.userId, role: body.role })
    .onConflictDoNothing();

  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId: id,
      action: "chat.member.add",
      target: body.userId,
      payload: { role: body.role },
    })
  );

  return c.json({ ok: true });
});

/** Remove a member. */
chatsRouter.delete("/:id/members/:userId", async (c) => {
  const { user, tenantId, db } = c.var.session;
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const [me] = await db
    .select({ role: schema.chatMember.role })
    .from(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, user.id)))
    .limit(1);
  // Members can remove themselves; only owners can remove others.
  if (!me || (me.role !== "owner" && targetUserId !== user.id)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await db
    .delete(schema.chatMember)
    .where(and(eq(schema.chatMember.chatId, id), eq(schema.chatMember.userId, targetUserId)));

  c.executionCtx.waitUntil(
    writeAudit(db, {
      tenantId,
      userId: user.id,
      chatId: id,
      action: "chat.member.remove",
      target: targetUserId,
    })
  );

  return c.json({ ok: true });
});

// Reference sql so drizzle's eslint plugin doesn't flag it as unused
void sql;
