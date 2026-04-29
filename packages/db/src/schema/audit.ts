import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { chat } from "./chat";
import { tenant } from "./tenant";
import { user } from "./auth";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    chatId: text("chat_id").references(() => chat.id, { onDelete: "set null" }),
    /** Dot-namespaced action e.g. 'db.query', 'artifact.write', 'chat.create' */
    action: text("action").notNull(),
    /** Free-form target identifier (chat id, profile id, sql hash, etc.) */
    target: text("target"),
    /** Safe-to-store summary; never raw creds, never raw rows. */
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_log_chat_idx").on(t.chatId),
    index("audit_log_action_idx").on(t.tenantId, t.action),
  ]
);

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
