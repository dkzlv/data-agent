/**
 * `db.*` ToolProvider — exposed to the codemode sandbox so the LLM can
 * introspect and query the user's connected Postgres database.
 *
 * Inside an agent's code function:
 *   await db.introspect()                           // schema overview
 *   await db.query("SELECT * FROM users LIMIT 10")  // safe SELECT
 *   await db.query("SELECT * FROM users WHERE id = $1", [42])
 *
 * Safety rails (defense in depth — the sandbox already has globalOutbound:null,
 * but credentials still flow through us):
 *   - SELECT/WITH/EXPLAIN/SHOW only. Anything starting with INSERT, UPDATE,
 *     DELETE, MERGE, CREATE, DROP, ALTER, TRUNCATE, GRANT, REVOKE, COMMIT,
 *     ROLLBACK, BEGIN, START, VACUUM, REINDEX, COPY, CALL, DO, LISTEN,
 *     NOTIFY is rejected before sending to Postgres.
 *   - Per-query statement_timeout = 15s (set as a session GUC inside an
 *     anonymous transaction).
 *   - Hard row cap (default 5000) enforced *after* the result returns —
 *     queries are wrapped in `SELECT * FROM (<query>) _q LIMIT N+1` so we
 *     can detect truncation cleanly.
 *   - Total result payload cap (default 4 MB) — we count bytes as we
 *     serialize the rows; if exceeded we truncate and flag `truncated:true`.
 */
import type { ToolProvider } from "@cloudflare/codemode";
import type { DataDbContext } from "../data-db";

const DEFAULT_ROW_LIMIT = 5_000;
const DEFAULT_BYTE_LIMIT = 4 * 1024 * 1024;
const STATEMENT_TIMEOUT_MS = 15_000;

const READONLY_LEADING_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "EXPLAIN",
  "SHOW",
  "VALUES",
  "TABLE",
  "FETCH",
  "DECLARE", // cursor declarations are read-only
]);

const FORBIDDEN_KEYWORDS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bMERGE\b/i,
  /\bCREATE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bTRUNCATE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCOMMIT\b/i,
  /\bROLLBACK\b/i,
  /\bBEGIN\b/i,
  /\bSTART\b/i,
  /\bVACUUM\b/i,
  /\bREINDEX\b/i,
  /\bCOPY\b/i,
  /\bCALL\b/i,
  /\bLISTEN\b/i,
  /\bNOTIFY\b/i,
  /\bSET\s+(SESSION|LOCAL)\b/i, // SET … is allowed inside CTEs / EXPLAIN, blocked at top level
];

/** Strip line + block comments so keyword detection isn't fooled. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*\n?/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

function firstKeyword(sql: string): string {
  const trimmed = stripComments(sql).trim().replace(/^\(+/, "").trim();
  const m = trimmed.match(/^([A-Za-z]+)/);
  return m ? m[1]!.toUpperCase() : "";
}

/** @internal — exported for unit tests; do not call directly. */
export function _looksReadOnly(sql: string): { ok: true } | { ok: false; reason: string } {
  return looksReadOnly(sql);
}

function looksReadOnly(sql: string): { ok: true } | { ok: false; reason: string } {
  const cleaned = stripComments(sql);
  const kw = firstKeyword(cleaned);
  if (!READONLY_LEADING_KEYWORDS.has(kw)) {
    return {
      ok: false,
      reason: `db.query is read-only — statements must begin with SELECT/WITH/EXPLAIN/SHOW (got "${kw || "<empty>"}")`,
    };
  }
  for (const re of FORBIDDEN_KEYWORDS) {
    if (re.test(cleaned)) {
      return {
        ok: false,
        reason: `db.query rejected — statement contains forbidden keyword (${re.source.replace(/\\b/g, "")})`,
      };
    }
  }
  // Block stacked statements. Postgres parameterized queries don't allow
  // multi-statement, but we strip semis defensively.
  const noSemi = cleaned.replace(/;\s*$/, "");
  if (noSemi.includes(";")) {
    return { ok: false, reason: "db.query rejected — multi-statement queries are not allowed" };
  }
  return { ok: true };
}

interface QueryOptions {
  /** Per-call row cap (defaults to 5000). */
  limit?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the row cap or byte cap kicked in. */
  truncated: boolean;
  /** Field metadata (best-effort — postgres.js exposes via `.columns` on the result). */
  columns: { name: string; dataType: string }[];
  /** Round-trip duration in ms. */
  durationMs: number;
}

export interface IntrospectionResult {
  database: string;
  schemas: {
    name: string;
    tables: {
      name: string;
      kind: "table" | "view" | "matview" | "foreign";
      estimatedRows: number | null;
      columns: {
        name: string;
        dataType: string;
        nullable: boolean;
        defaultValue: string | null;
        isPrimaryKey: boolean;
      }[];
      foreignKeys: {
        column: string;
        referencesSchema: string;
        referencesTable: string;
        referencesColumn: string;
      }[];
    }[];
  }[];
  fetchedAt: string;
}

const DB_TYPES = `
declare const db: {
  /** Returns a structured snapshot of the database's user-visible schema:
   *  schemas, tables, columns (with types + nullability + defaults),
   *  primary keys, foreign keys, and estimated row counts. Excludes the
   *  pg_catalog and information_schema schemas. */
  introspect(): Promise<{
    database: string;
    schemas: Array<{
      name: string;
      tables: Array<{
        name: string;
        kind: "table" | "view" | "matview" | "foreign";
        estimatedRows: number | null;
        columns: Array<{
          name: string;
          dataType: string;
          nullable: boolean;
          defaultValue: string | null;
          isPrimaryKey: boolean;
        }>;
        foreignKeys: Array<{
          column: string;
          referencesSchema: string;
          referencesTable: string;
          referencesColumn: string;
        }>;
      }>;
    }>;
    fetchedAt: string;
  }>;

  /** Run a *read-only* SQL query against the connected Postgres database.
   *
   *  - Only SELECT / WITH / EXPLAIN / SHOW / VALUES are accepted.
   *  - Use parameter placeholders (\\$1, \\$2…) — never interpolate values
   *    into the SQL string.
   *  - Results capped at \`opts.limit\` rows (default 5000) and ~4 MB total.
   *    When truncated, \`truncated\` is true.
   *  - statement_timeout enforced server-side at 15 s. */
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
    opts?: { limit?: number }
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number;
    truncated: boolean;
    columns: Array<{ name: string; dataType: string }>;
    durationMs: number;
  }>;
};
`;

/**
 * Build a `ToolProvider` whose `db.*` namespace executes against the
 * data-db handle returned by `getDataDb(agent)`. We accept a *getter*
 * rather than the connection itself so the connection can be opened
 * lazily (and reset between turns if the user swaps profiles).
 */
export function dbTools(getCtx: () => Promise<DataDbContext>): ToolProvider {
  const introspect = async (): Promise<IntrospectionResult> => {
    const ctx = await getCtx();
    const { sql } = ctx;

    // Single round-trip introspection. The query is purposely written so
    // that one driver call yields the full picture; this beats N+1 lookups
    // on schemas with many tables.
    type SchemaRow = {
      schema_name: string;
      table_name: string;
      table_kind: "r" | "v" | "m" | "f";
      column_name: string;
      ordinal_position: number;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      is_primary_key: boolean;
      estimated_rows: number | null;
    };
    const tableRows = (await sql`
      SELECT
        n.nspname           AS schema_name,
        c.relname           AS table_name,
        c.relkind           AS table_kind,
        a.attname           AS column_name,
        a.attnum            AS ordinal_position,
        format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull    AS is_nullable,
        pg_get_expr(d.adbin, d.adrelid) AS column_default,
        EXISTS (
          SELECT 1 FROM pg_constraint pk
          WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY(pk.conkey)
        ) AS is_primary_key,
        CASE c.relkind
          WHEN 'r' THEN c.reltuples::bigint
          WHEN 'm' THEN c.reltuples::bigint
          ELSE NULL
        END AS estimated_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relkind IN ('r','v','m','f')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        AND n.nspname NOT LIKE 'pg_temp_%'
      ORDER BY n.nspname, c.relname, a.attnum
    `) as unknown as SchemaRow[];

    type FkRow = {
      schema_name: string;
      table_name: string;
      column_name: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
    };
    const fkRows = (await sql`
      SELECT
        n.nspname  AS schema_name,
        c.relname  AS table_name,
        a.attname  AS column_name,
        nf.nspname AS ref_schema,
        cf.relname AS ref_table,
        af.attname AS ref_column
      FROM pg_constraint con
      JOIN pg_class c   ON c.oid = con.conrelid
      JOIN pg_namespace n  ON n.oid = c.relnamespace
      JOIN pg_class cf  ON cf.oid = con.confrelid
      JOIN pg_namespace nf ON nf.oid = cf.relnamespace
      JOIN unnest(con.conkey)  WITH ORDINALITY AS k(att, ord) ON TRUE
      JOIN unnest(con.confkey) WITH ORDINALITY AS f(att, ord) ON f.ord = k.ord
      JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.att
      JOIN pg_attribute af ON af.attrelid = cf.oid AND af.attnum = f.att
      WHERE con.contype = 'f'
        AND n.nspname NOT IN ('pg_catalog','information_schema')
    `) as unknown as FkRow[];

    // Group into nested structure.
    const schemas = new Map<string, IntrospectionResult["schemas"][number]>();
    for (const r of tableRows) {
      let schema = schemas.get(r.schema_name);
      if (!schema) {
        schema = { name: r.schema_name, tables: [] };
        schemas.set(r.schema_name, schema);
      }
      let table = schema.tables.find((t) => t.name === r.table_name);
      if (!table) {
        const kind: "table" | "view" | "matview" | "foreign" =
          r.table_kind === "v"
            ? "view"
            : r.table_kind === "m"
              ? "matview"
              : r.table_kind === "f"
                ? "foreign"
                : "table";
        table = {
          name: r.table_name,
          kind,
          estimatedRows: r.estimated_rows,
          columns: [],
          foreignKeys: [],
        };
        schema.tables.push(table);
      }
      table.columns.push({
        name: r.column_name,
        dataType: r.data_type,
        nullable: r.is_nullable,
        defaultValue: r.column_default,
        isPrimaryKey: r.is_primary_key,
      });
    }
    for (const r of fkRows) {
      const schema = schemas.get(r.schema_name);
      if (!schema) continue;
      const table = schema.tables.find((t) => t.name === r.table_name);
      if (!table) continue;
      table.foreignKeys.push({
        column: r.column_name,
        referencesSchema: r.ref_schema,
        referencesTable: r.ref_table,
        referencesColumn: r.ref_column,
      });
    }

    return {
      database: ctx.profile.database,
      schemas: [...schemas.values()].sort((a, b) => a.name.localeCompare(b.name)),
      fetchedAt: new Date().toISOString(),
    };
  };

  const query = async (
    rawSql: unknown,
    rawParams: unknown,
    rawOpts: unknown
  ): Promise<QueryResult> => {
    if (typeof rawSql !== "string" || rawSql.trim() === "") {
      throw new Error("db.query(sql, params?, opts?) — `sql` must be a non-empty string");
    }
    const params: unknown[] = Array.isArray(rawParams) ? (rawParams as unknown[]) : [];
    const opts = (rawOpts ?? {}) as QueryOptions;
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_ROW_LIMIT, 1), DEFAULT_ROW_LIMIT);

    const safety = looksReadOnly(rawSql);
    if (!safety.ok) throw new Error(safety.reason);

    const ctx = await getCtx();
    const { sql } = ctx;
    const t0 = Date.now();

    // Wrap the user's query so we can enforce a hard row cap one row above
    // their requested limit (so we can detect truncation).
    const wrapped = `SELECT * FROM (${rawSql.replace(/;\s*$/, "")}) AS _q LIMIT ${limit + 1}`;

    // Execute inside a transaction with statement_timeout set as a local GUC.
    // postgres.js's `.unsafe()` is what we need to pass a parameterized
    // pre-built SQL string + params array.
    // postgres.js's transaction sql is a `TransactionSql`; we treat it
    // structurally — `.unsafe()` accepts a SQL string + parameter array
    // and returns the row list. Casts are localized so we don't pollute
    // the public types.
    const result = (await sql.begin(async (tx) => {
      await (tx as unknown as { unsafe: (s: string) => Promise<unknown> }).unsafe(
        `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`
      );
      return (
        tx as unknown as {
          unsafe: (s: string, p?: unknown[]) => Promise<unknown>;
        }
      ).unsafe(wrapped, params);
    })) as unknown as Record<string, unknown>[] & {
      columns?: { name: string; type: number; parser?: unknown }[];
    };

    const truncatedByRows = result.length > limit;
    const rows = truncatedByRows ? result.slice(0, limit) : result;

    // Estimate payload size and trim further if needed.
    let bytes = 0;
    let cutoff = rows.length;
    for (let i = 0; i < rows.length; i++) {
      bytes += JSON.stringify(rows[i]).length;
      if (bytes > DEFAULT_BYTE_LIMIT) {
        cutoff = i;
        break;
      }
    }
    const truncatedByBytes = cutoff < rows.length;
    const finalRows = truncatedByBytes ? rows.slice(0, cutoff) : rows;

    const cols = (result.columns ?? []).map((c) => ({
      name: c.name,
      dataType: String(c.type),
    }));

    return {
      rows: finalRows,
      rowCount: finalRows.length,
      truncated: truncatedByRows || truncatedByBytes,
      columns: cols,
      durationMs: Date.now() - t0,
    };
  };

  return {
    name: "db",
    types: DB_TYPES,
    positionalArgs: true,
    tools: {
      introspect: {
        description:
          "Snapshot the user's database schema (tables, columns, FKs, estimated row counts).",
        execute: async () => introspect(),
      },
      query: {
        description:
          "Run a read-only SQL query (SELECT/WITH/EXPLAIN/SHOW). Capped at 5000 rows / 4 MB / 15 s.",
        execute: async (...args: unknown[]) => query(args[0], args[1], args[2]),
      },
    },
  };
}
