import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Placeholder table to validate the Drizzle + Neon + migrations wiring
 * before the real schema lands in c97933. Will be dropped by a later
 * migration.
 */
export const _health = pgTable("_health", {
  id: serial("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
