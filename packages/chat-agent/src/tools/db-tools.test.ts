import { describe, expect, it } from "vitest";
import { _looksReadOnly as looksReadOnly } from "./db-tools";

describe("db.query safety: looksReadOnly", () => {
  it("accepts simple SELECT", () => {
    expect(looksReadOnly("SELECT * FROM users")).toEqual({ ok: true });
  });

  it("accepts CTEs (WITH …)", () => {
    expect(looksReadOnly("WITH x AS (SELECT 1) SELECT * FROM x")).toEqual({ ok: true });
  });

  it("accepts EXPLAIN", () => {
    expect(looksReadOnly("EXPLAIN ANALYZE SELECT 1")).toEqual({ ok: true });
  });

  it("ignores leading parens (subquery formatting)", () => {
    expect(looksReadOnly("(SELECT 1)")).toEqual({ ok: true });
  });

  it("strips block + line comments before checking", () => {
    expect(looksReadOnly("/* hi */ -- x\n SELECT 1")).toEqual({ ok: true });
  });

  it("rejects empty queries", () => {
    const r = looksReadOnly("   \n  ");
    expect(r.ok).toBe(false);
  });

  it.each([
    "INSERT INTO x VALUES (1)",
    "UPDATE x SET y = 1",
    "DELETE FROM x",
    "DROP TABLE x",
    "TRUNCATE x",
    "ALTER TABLE x ADD COLUMN y int",
    "GRANT ALL ON x TO y",
    "BEGIN; SELECT 1; COMMIT",
    "VACUUM ANALYZE",
    "COPY x FROM '/tmp/y'",
    "CALL my_proc()",
    "LISTEN ch",
    "MERGE INTO x USING y",
  ])("rejects %s", (q) => {
    const r = looksReadOnly(q);
    expect(r.ok).toBe(false);
  });

  it("rejects DELETE hidden inside a comment-stripped string", () => {
    // "select" leading but DELETE keyword present elsewhere
    const r = looksReadOnly("SELECT (SELECT 1); DELETE FROM x");
    expect(r.ok).toBe(false);
  });

  it("rejects multi-statement queries", () => {
    const r = looksReadOnly("SELECT 1; SELECT 2");
    expect(r.ok).toBe(false);
  });

  it("allows trailing semicolon", () => {
    expect(looksReadOnly("SELECT 1;")).toEqual({ ok: true });
  });

  it("rejects SET SESSION attempts", () => {
    const r = looksReadOnly("SET SESSION foo = 1");
    expect(r.ok).toBe(false);
  });
});
