# Security self-audit (`d7943e/c87874`)

Cross-reference between [`SECURITY.md`](./SECURITY.md) (claims) and
the actual implementation as of commit `8ba1aa3`. This document is
the artifact of subtask `c87874`. Findings are tagged
**P0** (must fix before alpha), **P1** (should fix before alpha), or
**P2** (post-alpha follow-up). Every finding either has a fix
landed in this commit or a tracking note for later.

## Scope

I walked every claim in `SECURITY.md` (T1–T6 + caps + regression
tests) against the source tree and noted divergences. I did **not**:

- Re-derive threat-model coverage. The model in `SECURITY.md` is
  treated as ground truth.
- Audit Cloudflare-platform invariants (Workers Loader isolation,
  Secrets Store boundaries, DO storage encryption). Out of scope by
  declaration.
- Run dynamic tests against a fresh attacker DB. The forbidden-
  keyword regex is the only thing testable in unit tests; the
  `transaction_read_only` enforcement requires a live DB and is
  flagged for post-alpha automation (P2).

## Findings + remediations

### P0-1 · CORS reflective with credentials → cross-origin credential leak [FIXED]

**Symptom.** `packages/api-gateway/src/index.ts` previously did:

```ts
const origin = c.req.header("origin") ?? c.env.APP_URL;
return cors({ origin, credentials: true, ... });
```

This echoes the request's `Origin` back as
`Access-Control-Allow-Origin` with credentials enabled, meaning
**any malicious site** (`https://evil.example`) could trigger
authenticated `fetch()`s against `data-agent-api-gateway` and read
the response, exfiltrating chat history, DB profile metadata, and
audit rows.

**Fix.** Closed-list CORS:

- `APP_URL` is always allowed.
- `localhost:*` and `127.0.0.1:*` are allowed (dev convenience).
- Optional `CORS_EXTRA_ORIGINS` env var for staging mirrors.
- Anything else falls through to `APP_URL`, which the browser
  rejects when the request origin doesn't match.

Diff lives in this commit (`packages/api-gateway/src/index.ts`,
`packages/api-gateway/src/env.ts`).

**Why this slipped earlier.** The reflective default came from
copy-pasting a Hono CORS example (single-origin SPA pattern). It
worked correctly in same-origin tests, so the cross-origin failure
mode never surfaced.

### P1-1 · Missing `transaction_read_only = on` in `db.query` [FIXED]

**Symptom.** `SECURITY.md` T2 claimed:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
```

The actual code in `packages/chat-agent/src/tools/db-tools.ts`
issued plain `BEGIN` followed by `SET LOCAL statement_timeout`, with
no read-only guard. Mutation prevention rested entirely on the
forbidden-keyword regex (`INSERT|UPDATE|...`). The doc claim that
"the DB rejects writes at the protocol level" was not actually
enforced.

**Risk.** A regex bypass — e.g. a malformed comment, a UTF-8
homograph, or a future keyword the list misses (`COPY` was added
late, `LOCK` is borderline) — would silently execute against the
user's DB. The threat model treats this as P1 because we have not
seen a working bypass; the absent layer was unclaimed defense-in-
depth.

**Fix.** Added a second `SET LOCAL transaction_read_only = on` in
the same transaction (commit also lands here). Updated `SECURITY.md`
to show the actual SQL form.

**Note.** `transaction_read_only` is a Postgres-native guard
(rejected DML returns
`ERROR: cannot execute INSERT in a read-only transaction`). It
cannot itself be bypassed inside the transaction.

### P1-2 · `statement_timeout` doc said 15 s, code is 25 s [FIXED]

**Symptom.** `STATEMENT_TIMEOUT_MS = 25_000` in
`packages/chat-agent/src/tools/db-tools.ts`; doc said 15 s. The
value was bumped during ef7df2 debugging when cold-Neon
`DISTINCT ON` queries were timing out (sandbox gives 30 s, we need
~5 s overhead, so 25 s fits). Doc wasn't updated.

**Fix.** `SECURITY.md` now lists 25 s. Also added a note explaining
*why* (sandbox 30 s − ~5 s margin) so it doesn't drift again.

### P1-3 · Regression-test table referenced nonexistent files [FIXED]

**Symptom.** `SECURITY.md` cited
`src/data-db.test.ts` and
`tests/auth-gate.spec.ts (api-gateway)`. Neither file exists.

```bash
$ ls packages/chat-agent/src/data-db.test.ts
ls: ... No such file or directory
$ ls packages/api-gateway/tests/
ls: ... No such file or directory
```

**Risk.** Misleading audit story — readers (including future-me) see
the table and assume coverage that isn't there.

**Fix.** Replaced the table with the actual 8-file test inventory
(82 tests). Added an explicit "what we don't have automated yet"
section listing:

- Live integration test for `transaction_read_only` enforcement.
- WS-auth 401 unit test (covered by the manual spike script).

### P2-1 · No automated test for live `transaction_read_only`

The new server-side read-only guard added in P1-1 has no automated
regression. A real fix needs a throwaway Postgres DB the test can
write to, then a test asserting that the wrapped statement is
rejected. Tracked for post-alpha. Until then the claim rests on:

1. The Postgres documentation (read-only enforcement is a
   well-known DB invariant).
2. Manual smoke (`pnpm tsx packages/chat-agent/scripts/debug-chat.ts`
   driving a `db.query` with `INSERT` in the body — the keyword
   regex catches it before SQL even runs).

### P2-2 · Cookie SameSite + Secure depends on environment

`packages/api-gateway/src/auth.ts` configures Better Auth cookies
based on `COOKIE_DOMAIN`:

- `*.workers.dev` (alpha) → `SameSite=None; Secure`
- A dotted custom domain (later) → `SameSite=Lax; Domain=.dkzlv.com`

Both modes are correct, but the switch is environment-driven, which
means a wrong env var flips us to the wrong mode silently. Two
mitigations:

1. The check `secure: env.API_URL.startsWith("https://")` ensures we
   never *downgrade* to insecure cookies in prod by accident.
2. The cookie domain is part of `Set-Cookie`; a misconfigured
   domain would surface as "user can't sign in" — fail-loud not
   silent-leak.

No fix needed for alpha. Document for post-alpha rotation.

### P2-3 · `messageConcurrency: "queue"` relies on Think default

`SECURITY.md` claims tool-call depth is bounded by
`messageConcurrency: queue`. We never set this explicitly; we
inherit Think's default. If a future Think upgrade changed the
default to `"interleave"` we'd silently lose FIFO turn-locking.

**Mitigation.** Pin the value explicitly when we touch the agent
next. Tracked for the next chat-agent change.

### P2-4 · Rate-limit windows use audit_log as the counter store

The current rate limiter (`packages/chat-agent/src/rate-limits.ts`)
counts `turn.start` audit rows. This means:

- An audit-write failure (network blip, Neon outage) skews the
  counter low → user gets one extra turn.
- A user under sustained load makes `audit_log` grow at 50 rows/day
  per chat. At 10k chats this is fine; at 1M it'd warrant a
  dedicated counter table.

Both are acceptable for alpha (capped users, capped traffic). After
alpha, move counters to a Workers KV namespace or DO storage with
cheaper read patterns.

### P2-5 · No PII redaction in audit payloads

`SECURITY.md` is honest about this ("we do not claim PII redaction
in chat messages"). Worth restating in this audit: the
`audit_log.payload` JSON contains user-typed text (truncated by
`safePayload` to 4 KiB). If a tenant types a customer email or
SSN, it lands in the audit log.

This is an explicit non-goal for alpha. Tenants are responsible for
not pasting sensitive content into the agent.

## Confirmed claims

The following `SECURITY.md` claims hold against the source as of
this commit:

- **T1 sandbox isolation.** `DynamicWorkerExecutor` is constructed
  3× in `agent.ts`, every site sets `globalOutbound: null` and
  `timeout: 30_000`. `spike-sandbox.ts` covers both invariants
  against deployed code.
- **T2 forbidden-keyword regex** matches the doc list exactly
  (`INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|CLUSTER|REINDEX|REFRESH|COPY|CALL|DO|LISTEN|NOTIFY|UNLISTEN|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT`). Top-level keyword whitelist is `SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE|FETCH|DECLARE`. Multi-statement detection uses the same comment-strip path used by the keyword scan. 5000 row / 4 MiB caps are enforced after the SQL returns.
- **T3 read-only role recommendation.** Documented in
  `SECURITY.md`; we don't and can't enforce.
- **T4 chat token JWT.** `mintChatToken` (api-gateway) → 5-minute
  HS256 → `verifyChatToken` (chat-agent's `onBeforeConnect` /
  `onBeforeRequest`). Claims include
  `userId | tenantId | chatId`, all checked against the requested
  path. `requireSession()` middleware on every protected route.
- **T5 401-on-missing-token.** WS upgrade rejects with 401; HTTP
  artifact endpoints reject with 401; chat-agent itself returns
  401 on missing/invalid token. `app.notFound` returns 404 to
  hide route topology.
- **T6 domain allow-list.** `sendMagicLink` short-circuits silently
  for non-allowlisted domains. Signup endpoint always returns
  `200 {"status":true}` (no enumeration). Logs only the domain,
  never the local-part. Defaults to `indent.com`.
- **AES-GCM envelope encryption** is implemented in
  `packages/shared/src/encryption.ts` with per-tenant DEK
  + per-account master key, `additionalData` binding, and
  round-trip tests in `encryption.test.ts`.
- **Chat token TTL = 300 s** (`DEFAULT_TTL_SECONDS = 300`).
- **Rate-limit windows** match the doc table exactly:
  50/chat/day, 20/user/hour, 200/tenant/day.

## Operational follow-ups

These aren't security findings per se but came up while auditing.
Ops should know about them.

### Credential rotation runbook

Stored secrets and how to rotate them without downtime:

| Secret                       | Where                       | Rotation                                                |
| ---------------------------- | --------------------------- | ------------------------------------------------------- |
| `INTERNAL_JWT_SIGNING_KEY`   | CF Secrets Store            | Rotate by adding a new key, deploying chat-agent w/ both, then api-gateway w/ new only. 5-min downtime window equals the chat-token TTL. |
| `MASTER_ENCRYPTION_KEY`      | CF Secrets Store            | Re-encrypt every `db_profiles` row with new key. Run as a one-shot script before flipping the env var. |
| `CONTROL_PLANE_DB_URL`       | CF Secrets Store            | Standard Neon credential rotation. Reissue + redeploy. |
| Tenant DB profile creds      | Encrypted in Postgres       | User-driven. Owner edits the profile in the UI (which we don't have yet — curl). |
| Better Auth session secret   | Better Auth-managed         | Rotated automatically per Better Auth.                  |

### Logs to watch in production

Filters for the Workers Logs dashboard (subtask 9fa055 events):

- `event = "audit.write_failed"` → audit storage degraded
- `event = "chat.tool_call" AND success = false` → tool layer issues
- `event = "chat.turn_error" AND level = "error"` → user-visible failures
- `event = "chat.auth_failed"` → potential probe activity
- `event = "api.request" AND status >= 500` → unexpected errors

## Re-audit checklist

When `SECURITY.md` changes, re-walk this audit by running:

```bash
# Show every assertion in SECURITY.md and grep for the claim text
rg -n "^### " SECURITY.md
rg -n "globalOutbound|transaction_read_only|statement_timeout|FORBIDDEN_KEYWORDS|mintChatToken|verifyChatToken|ALLOWED_EMAIL_DOMAINS|messageConcurrency|AES-GCM" packages/

# Re-run the test suite
pnpm -r run test

# Re-run the live sandbox probe
pnpm --filter @data-agent/chat-agent exec tsx scripts/spike-sandbox.ts
```

The "every assertion has a passing test or a documented exception"
property is the bar. Anything else gets a P0 finding.
