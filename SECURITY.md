# Security model

This document describes the threat model and the defense-in-depth
controls in `data-agent`. It is the source of truth for subtask
`d7943e/2173ac` (sandbox hardening) and the input to the self-audit in
`d7943e/c87874`.

## Threat model

`data-agent` runs **untrusted, model-generated TypeScript** against a
**user-provided Postgres connection** on every turn. The two assets we
must protect:

1. **The user's database.** No writes, no schema changes, no resource
   exhaustion, no exfiltration of credentials.
2. **The Cloudflare account & other tenants.** Code Mode sandboxes must
   not reach the control-plane DB, the secrets store, other tenants'
   chats, or the public internet.

### Adversaries we model

| Adversary                           | Capability                                                    | Mitigation tier |
| ----------------------------------- | ------------------------------------------------------------- | --------------- |
| Confused-deputy LLM                 | Generates SQL or JS that's accidentally destructive           | T1, T2, T3      |
| Prompt-injected LLM                 | DB content steers the LLM into "drop all tables" or similar   | T1, T2, T3      |
| Malicious tenant member             | Logged-in user attempting to read another tenant's data       | T4              |
| Anonymous attacker                  | Unauthenticated WS / HTTP requests to chat-agent              | T5              |

Out of scope (documented for honesty):

- Cloudflare platform compromise (Workers Loader, DO storage, secrets store).
- Side-channels in V8 itself (Spectre etc. — we rely on CF mitigations).
- Social engineering of the human owner of a tenant.

## Defense tiers

### T1. Code Mode sandbox isolation

Every piece of model-generated code runs through `@cloudflare/codemode`
in a **Worker Loader-isolated worker**, configured with:

```ts
new DynamicWorkerExecutor({
  loader: env.LOADER,
  timeout: 30_000,         // CPU/wall-clock cap
  globalOutbound: null,    // no fetch, no socket, no DNS
});
```

`globalOutbound: null` means the loaded worker has **no network**:
`fetch()` throws, `connect()` is unavailable, even DNS lookups fail.
The sandbox cannot talk to the control-plane DB, the user DB, the
secrets store, KV, or the public internet — it can only call the
**capabilities we explicitly bind in** (the `db.*`, `chart.*`,
`artifact.*`, `vegaLite.*` tools provided by the host worker).

The 30 s timeout fires regardless of what the script does — synchronous
infinite loops, `await new Promise(() => {})`, or runaway recursion all
get killed.

These two invariants are verified live by `scripts/spike-sandbox.ts`,
which runs every deploy:

- `sandboxNetworkProbe`: loaded code calls `fetch("https://example.com")`
  and asserts it throws.
- `sandboxTimeoutProbe`: loaded code spins on a 60-second busy-loop,
  asserts the executor returns within ~5 s and surfaces an error.

### T2. SQL allow-list (`db.query`)

The `db.query` tool refuses anything that isn't a read:

- Strip comments → reject if any forbidden keyword appears
  (`INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|CLUSTER|REINDEX|REFRESH|COPY|CALL|DO|LISTEN|NOTIFY|UNLISTEN|LOCK|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT`).
- Top-level statement must start with `SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE|FETCH|DECLARE`.
- Multiple statements (`;` outside string literals) are rejected.

Even after the allow-list, every query is wrapped in:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT * FROM ( <user query> ) _ LIMIT <N+1>;
```

with hard caps:

| Cap                 | Default |
| ------------------- | ------- |
| Rows returned       | 5,000   |
| Bytes returned      | 4 MiB   |
| Statement timeout   | 15 s    |
| Total query timeout | 30 s    |

`READ ONLY` transactions are enforced by Postgres itself — even if the
allow-list is somehow bypassed, the DB rejects writes at the protocol
level.

### T3. Per-chat Postgres roles (recommended, documented)

Owners are instructed to create a **read-only role** scoped to the
schemas they want exposed:

```sql
CREATE ROLE data_agent_ro LOGIN PASSWORD '<random>';
GRANT USAGE ON SCHEMA public TO data_agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO data_agent_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO data_agent_ro;
```

The connection string stored in `db_profiles.encrypted_url` should use
this role. We surface this in the DB-profile UI as a recommendation;
we cannot enforce it (we don't validate the role server-side).

### T4. Tenant + chat membership checks

Every chat-scoped HTTP and WS request flows through the api-gateway,
which enforces:

1. **Session validity** (`requireSession` — Better Auth session cookie).
2. **Tenant membership** — the user belongs to the tenant that owns the
   chat. Cross-tenant access returns 404 (not 403, to avoid existence
   leaks).
3. **Chat membership** — the user is a member of the specific chat.
4. **Mints a short-lived chat token** (HS256 JWT, 5 min, signed with
   `INTERNAL_JWT_SIGNING_KEY`) embedded with `userId|tenantId|chatId`.

The chat-agent worker re-verifies the token in
`onBeforeConnect`/`onBeforeRequest`. The DO never trusts the path
parameter — it trusts only the verified JWT claims. This is
**defense-in-depth**: even a chat-agent URL leaked publicly cannot be
used to join a chat without a fresh token from the gateway.

### T5. WS/HTTP authentication

- WS connections require `?token=<jwt>` (browsers cannot set headers on
  WebSocket). The token is the chat token from T4.
- HTTP artifact downloads require the same token via `Authorization:
  Bearer` or `?token=`.
- All non-token paths return 401.
- The chat-agent worker has no `/health` or other public endpoints —
  every route either requires a token or returns 404.

## Auditable resource caps

| Limit                        | Value                  | Enforced by                         |
| ---------------------------- | ---------------------- | ----------------------------------- |
| Sandbox CPU/wall             | 30 s                   | `DynamicWorkerExecutor.timeout`     |
| Sandbox network              | None                   | `globalOutbound: null`              |
| SQL statement timeout        | 15 s                   | `SET LOCAL statement_timeout`       |
| SQL rows                     | 5,000                  | `LIMIT N+1`                         |
| SQL bytes                    | 4 MiB                  | `db.query` byte-counting            |
| Turns/chat/day               | 50                     | `947c38` rate limiter (subtask)     |
| Output tokens/turn           | 8,192                  | Workers AI request param            |
| Tool-call depth/turn         | 3                      | `messageConcurrency: queue` + cap   |
| Chat token TTL               | 5 min                  | `mintChatToken`                     |
| DB-profile creds at rest     | AES-GCM (per-tenant)   | `f0a0e9` envelope encryption        |

## What we do *not* claim

- We do not claim isolation against a malicious tenant **owner**
  attacking *their own* DB — they own that DB, that's not our problem.
- We do not claim protection against an attacker who steals
  `INTERNAL_JWT_SIGNING_KEY`, the secrets-store master key, or a
  user's session cookie. Those are the standard credential-rotation
  problems and are documented for ops in `c87874`.
- We do not claim PII redaction in chat messages or artifacts — owners
  are responsible for what they put in their DB.

## Regression tests

| Test                                    | Verifies                                          |
| --------------------------------------- | ------------------------------------------------- |
| `scripts/spike-sandbox.ts`              | T1 (network + timeout) live against deployed DO    |
| `src/tools/db-tools.test.ts`            | T2 (SQL allow-list, statement timeout, row caps)   |
| `src/data-db.test.ts`                   | Envelope encryption round-trip                     |
| `tests/auth-gate.spec.ts` (api-gateway) | T4/T5 — 401 on missing/invalid tokens              |

Any regression in these tests blocks deploy.
