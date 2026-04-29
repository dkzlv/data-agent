import { customType, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { tenant } from "./tenant";

/** Postgres bytea wrapper for envelope-encrypted payloads. */
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const dbProfileKind = pgEnum("db_profile_kind", ["postgres"]);

export const dbProfileTestStatus = pgEnum("db_profile_test_status", ["ok", "failed", "never"]);

export const dbProfile = pgTable(
  "db_profile",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: dbProfileKind("kind").notNull().default("postgres"),
    // Plaintext metadata — safe to display in UI
    host: text("host").notNull(),
    port: integer("port").notNull().default(5432),
    database: text("database").notNull(),
    sslmode: text("sslmode").notNull().default("require"),
    // Envelope-encrypted secret bundle (user/password/etc.)
    encryptedCredentials: bytea("encrypted_credentials").notNull(),
    encryptedDek: bytea("encrypted_dek").notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull().default(1),
    // Test status
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestedStatus: dbProfileTestStatus("last_tested_status").notNull().default("never"),
    lastTestedError: text("last_tested_error"),
    // Lifecycle
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("db_profile_tenant_idx").on(t.tenantId),
    index("db_profile_alive_idx").on(t.tenantId, t.deletedAt),
  ]
);

export type DbProfile = typeof dbProfile.$inferSelect;
export type NewDbProfile = typeof dbProfile.$inferInsert;
