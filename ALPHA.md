# Internal alpha rollout (subtask `dc09a3`)

This is the operator's playbook for landing `data-agent` in front of
the first batch of internal users. It is intentionally **manual and
boring** — automation comes after we know what's actually painful.

## Pre-flight

- [x] All 35 implementation subtasks of `d7943e` shipped
- [x] Production URLs healthy:
  - Web: <https://data-agent.dkzlv.com>
  - API: <https://data-agent-api-gateway.dkzlv.workers.dev>
  - Chat-agent: <https://data-agent-chat-agent.dkzlv.workers.dev>
- [x] Custom domains optional (subdomains work for alpha)
- [x] AI Gateway live: `2f7029a7ef2671db090d9304f595c42d/data-agent`
- [x] Cloudflare Email Sending verified for `data-agent.dkzlv.com`
- [x] `ALLOWED_EMAIL_DOMAINS=indent.com` enforced
- [x] Sample Neon read-only DB attached to every new tenant
- [x] Audit log + structured spans live (1dd311 + 9fa055)
- [x] Rate limits: 50 turns/chat/day, 20 turns/user/hour, 200/tenant/day

## Onboarding a new alpha user

1. Confirm their email is at one of the allow-listed domains
   (`ALLOWED_EMAIL_DOMAINS` env var, currently `indent.com`).
2. Send them <https://data-agent.dkzlv.com>.
3. They sign up by entering their email — magic-link arrives from
   `robot@data-agent.dkzlv.com`. Tell them to look in spam if it's
   the first time.
4. On first sign-in, the api-gateway auto-provisions:
   - A personal tenant
   - A `Sample: Neon employees DB` profile (read-only, 300k rows)
5. They can immediately ask: *"List all tables and the row count of
   each"* or *"Show me the top 5 highest-paid employees"*.

To onboard a domain that isn't `indent.com`:

```bash
# .dev.vars only — set in wrangler vars for prod
wrangler secret bulk --name data-agent-api-gateway -e production \
  ALLOWED_EMAIL_DOMAINS="indent.com,othercompany.com"
```

## Connecting their own Postgres

Currently a manual step — there's no profile-CRUD UI yet (we
shipped the API; the form is the next sprint). Workaround:

```bash
TOKEN=...  # get from browser cookie __Secure-better-auth.session_token
curl -X POST https://data-agent-api-gateway.dkzlv.workers.dev/api/db-profiles \
  -H "Cookie: __Secure-better-auth.session_token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production read-replica",
    "url": "postgresql://readonly:...@host/db?sslmode=require"
  }'
```

**Always insist on a read-only role.** The agent enforces
`SET LOCAL transaction_read_only = on` and rejects DML at the
SQL-allow-list layer, but defense-in-depth lives on the DB side.

## Monitoring during alpha

| Signal | Where | What to watch |
|--|--|--|
| Per-request span | Workers Logs → `data-agent-api-gateway` → filter `event = "api.request"` | spike in `status >= 500`, `durationMs > 5000` |
| Per-turn span | Workers Logs → `data-agent-chat-agent` → filter `event = "chat.turn_complete"` | `status = "error"` rate, `durationMs > 30000` |
| Tool calls | Workers Logs → filter `event = "chat.tool_call"` | `success: false` patterns by `tool` |
| Cost | AI Gateway → `data-agent` → Analytics | total $/day per tenant (`metadata.tenantId`) |
| Audit | Postgres `audit_log` table | `action = "turn.error"`, `db.query` row counts |

Quick-look query for "what failed today":

```sql
SELECT action, COUNT(*), MAX(created_at)
FROM audit_log
WHERE created_at > now() - interval '24 hours'
  AND action LIKE '%error%'
GROUP BY action
ORDER BY 2 DESC;
```

## Known limits the alpha user should expect

- **No data-profile UI yet.** Adding a DB profile requires a curl
  call (or asking the operator). Owners only.
- **One DB per chat.** A chat is bound at create time — to switch
  databases, start a new chat.
- **Read-only.** No `INSERT`/`UPDATE`/`DELETE` even if your role
  permits it. The agent strips multi-statement SQL and rejects
  forbidden keywords.
- **25-second SQL timeout.** Big scans will hit it. Add a `WHERE`
  or hit a smaller schema slice.
- **Caps:** 50 turns per chat per day, 20 per user per hour, 200
  per workspace per day. The UI shows a banner with retry time.
- **Reasoning visible.** The "thinking" block is collapsible but
  not hidden by default — that's deliberate while we tune the
  model. Tell people if it bothers them.
- **Charts.** Only Vega-Lite (line/bar/scatter/area). Anything else
  the model will *try* to express as a table.

## Escalation

| Symptom | First step | If not resolved |
|--|--|--|
| User can't sign in | Check `ALLOWED_EMAIL_DOMAINS` covers their domain | Restart magic-link flow, check Email Sending dashboard for delivery logs |
| Magic link not arriving | Workers Logs filter `event = "magic_link_sent"`; spam folder | Check CF Email Sending → `data-agent.dkzlv.com` analytics |
| Chat stuck on "thinking" | Browser console for WS lifecycle logs | `tsx packages/chat-agent/scripts/debug-clear.ts <chatId>` to wipe DO history |
| All tools failing | Workers Logs filter `event = "chat.tool_call" AND success = false` | Check sample-DB is reachable: `psql $SAMPLE_DB_URL -c '\dt employees.*'` |
| Sandbox timeout | Confirm 30s wall via `chat.tool_call` `durationMs` | Reduce row count (`db.query` already enforces 5000) or accept it |
| Worker error 500s | Workers Logs filter `level = "error"` | `wrangler tail data-agent-api-gateway` for live trace |

## Rollback

If the alpha goes sideways, the recovery is simple:

```bash
# 1. Disable signups (drop allow-list to nobody)
wrangler vars edit ALLOWED_EMAIL_DOMAINS=""

# 2. Or roll back to a known-good worker version
wrangler rollback --name data-agent-api-gateway
wrangler rollback --name data-agent-chat-agent
wrangler rollback --name data-agent-web
```

Existing sessions stay valid (Better Auth cookies, 7-day TTL); new
chats can't start because there's no DB profile. The
control-plane Postgres is the source of truth — nothing in DOs
matters across deploys.

## Out of scope for alpha

These are explicitly *not* shipped and won't be fixed during alpha
unless they're blocking. Documented so we don't get nerd-sniped.

- Tenant-level admin UI (audit viewer, billing, member invites)
- BYO LLM (locked to Workers AI Kimi K2.6)
- Chat sharing across tenants
- File upload / attachments
- Mobile-optimized layout
- Email digests / notifications
- SAML / SSO
- Per-user usage budgets in dollars
