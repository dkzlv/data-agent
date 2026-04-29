import { index, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { dbProfile } from "./db-profile";
import { tenant } from "./tenant";

export const chatMemberRole = pgEnum("chat_member_role", ["owner", "participant"]);

export const chat = pgTable(
  "chat",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    dbProfileId: text("db_profile_id").references(() => dbProfile.id, { onDelete: "set null" }),
    title: text("title").notNull().default("Untitled chat"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("chat_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("chat_alive_idx").on(t.tenantId, t.archivedAt),
  ]
);

export const chatMember = pgTable(
  "chat_member",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: chatMemberRole("role").notNull().default("participant"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.userId] }), index("chat_member_user_idx").on(t.userId)]
);

export type Chat = typeof chat.$inferSelect;
export type NewChat = typeof chat.$inferInsert;
export type ChatMember = typeof chatMember.$inferSelect;
