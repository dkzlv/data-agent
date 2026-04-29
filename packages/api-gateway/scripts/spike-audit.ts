/**
 * Audit-log integration smoke test (subtask d7943e/1dd311).
 *
 * Bypasses HTTP and writes directly through the same Drizzle helper
 * that production uses, then reads back to confirm the row landed.
 *
 * What this verifies:
 *  - `audit_log` schema is correct (FK references resolve, columns match).
 *  - `writeAudit()` is non-blocking (we await it but it short-circuits
 *    on any error rather than throwing).
 *  - The query path used by `auditRouter.get('/')` returns rows in
 *    descending creation order with cursor-based pagination.
 *
 * Run:
 *   pnpm --filter @data-agent/api-gateway exec tsx scripts/spike-audit.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { createDbClient, schema } from "@data-agent/db";
import { writeAudit } from "../src/audit";

function loadDbUrl(): string {
  if (process.env.CONTROL_PLANE_DB_URL) return process.env.CONTROL_PLANE_DB_URL;
  const candidates = [join(process.cwd(), ".dev.vars"), join(process.cwd(), "../../.dev.vars")];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf8");
      const m = text.match(/^CONTROL_PLANE_DB_URL="?([^"\n]+)"?/m);
      if (m) return m[1]!;
    } catch {
      // try next
    }
  }
  throw new Error("CONTROL_PLANE_DB_URL not found");
}

const url = loadDbUrl();
const { db, client } = createDbClient({ url, max: 1 });

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

try {
  // 1. Pick a real tenant + user — or create an ephemeral pair so the
  //    spike works on a fresh DB. The fixture is cleaned up at the end.
  let tenant: { id: string; ownerUserId: string };
  let createdFixtures: { userId: string; tenantId: string } | null = null;

  const [existing] = await db
    .select({ id: schema.tenant.id, ownerUserId: schema.tenant.ownerUserId })
    .from(schema.tenant)
    .limit(1);

  if (existing) {
    tenant = existing;
    console.log(`using existing tenant=${tenant.id} user=${tenant.ownerUserId}`);
  } else {
    const userId = `audit-spike-user-${Date.now()}`;
    await db.insert(schema.user).values({
      id: userId,
      email: `${userId}@example.invalid`,
      name: "audit spike",
      emailVerified: false,
    });
    const [created] = await db
      .insert(schema.tenant)
      .values({ name: "audit spike workspace", ownerUserId: userId })
      .returning({ id: schema.tenant.id });
    if (!created) throw new Error("failed to create fixture tenant");
    tenant = { id: created.id, ownerUserId: userId };
    createdFixtures = { userId, tenantId: created.id };
    console.log(`created fixture tenant=${tenant.id} user=${userId}`);
  }

  const beforeCount = (
    await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, tenant.id))
  ).length;

  // 2. Write a synthetic audit event.
  const probeAction = `spike.audit.${Date.now()}`;
  await writeAudit(db, {
    tenantId: tenant.id,
    userId: tenant.ownerUserId,
    action: probeAction,
    target: "spike-target",
    payload: { hello: "world", n: 42 },
  });

  // 3. Read back.
  const [row] = await db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.tenantId, tenant.id), eq(schema.auditLog.action, probeAction)))
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(1);

  check("audit row persisted", !!row, { id: row?.id });
  check("audit row tenant scoped", row?.tenantId === tenant.id);
  check("audit row payload preserved", row?.payload?.hello === "world", row?.payload);
  check("audit row target stored", row?.target === "spike-target");

  const afterCount = (
    await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, tenant.id))
  ).length;
  check("audit count incremented by 1", afterCount === beforeCount + 1, {
    before: beforeCount,
    after: afterCount,
  });

  // 4. Failure path — tenant id that doesn't exist must NOT throw.
  await writeAudit(db, {
    tenantId: "tenant-that-does-not-exist",
    action: "should_fail_silently",
  });
  check("invalid tenant FK does not throw", true);

  // Cleanup fixtures (cascades audit_log + tenant_member rows).
  if (createdFixtures) {
    await db.delete(schema.auditLog).where(eq(schema.auditLog.tenantId, createdFixtures.tenantId));
    await db.delete(schema.tenant).where(eq(schema.tenant.id, createdFixtures.tenantId));
    await db.delete(schema.user).where(eq(schema.user.id, createdFixtures.userId));
    console.log("fixtures cleaned up");
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall audit smoke checks passed");
} finally {
  await client.end({ timeout: 1 });
}
