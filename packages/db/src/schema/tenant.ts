import { index, pgEnum, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const tenantRole = pgEnum("tenant_role", ["owner", "admin", "member"]);

export const tenant = pgTable(
  "tenant",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenant_owner_idx").on(t.ownerUserId)]
);

export const tenantMember = pgTable(
  "tenant_member",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: tenantRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("tenant_member_user_idx").on(t.userId),
  ]
);

export type Tenant = typeof tenant.$inferSelect;
export type TenantMember = typeof tenantMember.$inferSelect;
