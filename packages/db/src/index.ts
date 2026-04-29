import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export type DbClientOptions = {
  /** Connection string. */
  url: string;
  /** Max pool size. Workers should keep this low (default 5). */
  max?: number;
};

/**
 * Create a Drizzle client backed by postgres.js.
 *
 * Tuned for Cloudflare Workers / Hyperdrive: `fetch_types: false` skips
 * a startup roundtrip that breaks in some Worker contexts.
 */
export function createDbClient(opts: DbClientOptions): {
  db: Database;
  client: postgres.Sql;
} {
  const client = postgres(opts.url, {
    max: opts.max ?? 5,
    fetch_types: false,
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export { schema };
export type Schema = typeof schema;
