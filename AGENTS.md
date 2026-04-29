# AGENTS.md

Project context for future agents working on this repository. Read
this first; it answers "where is X" and "how do we do Y" without
spelunking through the source. When a fact in this file disagrees
with the code, the code wins — open a PR to update this file.

## What is this

`data-agent` is a BYO-Postgres BI agent. A user signs in, attaches
a read-only Postgres URL, and chats with an LLM that runs untrusted
TypeScript in a Worker Loader sandbox to introspect their schema,
run SQL, and emit Vega-Lite charts. Multiple humans can share a
chat. Everything runs on Cloudflare.

Original spec & all subtask history: `todo show d7943e`.

Live URLs:
- Web — https://data-agent.dkzlv.com
- API — https://data-agent-api-gateway.dkzlv.workers.dev
- Chat-agent — https://data-agent-chat-agent.dkzlv.workers.dev

CF account `2f7029a7ef2671db090d9304f595c42d`. Secrets store
`5fca98fdba4f4972b9d14ac74ea58cf4`.

## Workspace layout

```
packages/
  shared/       types, JWT, encryption, audit, agent-error envelope, logEvent
  db/           Drizzle schema + migrations (control-plane Postgres on Neon)
  api-gateway/  Hono Worker: Better Auth, REST CRUD, WS upgrade reverse-proxy
  chat-agent/   ChatAgent DO extending @cloudflare/think + codemode + shell
  web/          TanStack Start app on Workers (uses @cloudflare/ai-chat/react)
```

`shared` is source-exported (`main: ./src/index.ts`) but **also
builds a `dist/`** that consumers' tsc may pick up. After editing
`shared/src/*` always run `pnpm --filter @data-agent/shared build`,
otherwise consumers will see "module has no exported member" on a
freshly added export. Source of past confusion.

## Top-level docs (in priority order for an agent)

| File | Purpose |
|--|--|
| `AGENTS.md` (this file) | Architecture + conventions snapshot |
| `CONTINUE.md` | Live progress checklist for `d7943e` (36/36 done) |
| `SECURITY.md` | Threat model + 6 defense tiers + caps table |
| `SECURITY-AUDIT.md` | Self-audit findings (P0 fixed, P1 fixed, P2 backlog) |
| `ALPHA.md` | Operator runbook for internal rollout |
| `README.md` | Brief external description |

## Stack & versions

| Layer | Choice | Why |
|--|--|--|
| Runtime | Cloudflare Workers + DOs | Single-platform, scales to zero, isolates |
| LLM | Workers AI `@cf/moonshotai/kimi-k2.6` | Free credits, good tool calling, fits in CF |
| AI Gateway | `data-agent` (id) | Cost/log/cache, replaces hand-rolled telemetry |
| Agent framework | `@cloudflare/think` 0.4.x | Chat lifecycle, FIFO turn lock, recovery |
| Sandbox | `@cloudflare/codemode` + `@cloudflare/shell` + Worker Loader | Untrusted TS isolation |
| AI SDK | Vercel `ai` v6 | Streaming + tool schemas |
| HTTP framework | Hono | Composable, fits Workers |
| Web framework | TanStack Start on CF Workers | SSR + filesystem routing |
| Auth | Better Auth (magic link) | Stateful sessions, cheap session table |
| Database | Postgres via Neon | Control plane storage |
| ORM | Drizzle + postgres.js | TS-first, fits Workers |
| Bundler | wrangler | Worker-aware |
| Package manager | pnpm 10 workspaces | Fast, link-friendly |
| Lint | oxlint | Fast |
| Format | biome | Fast |
| Hooks | lefthook | Pre-commit format+lint, pre-push typecheck |
| Tests | vitest | Per-package, source-export friendly |
| Charts | vega-embed (web) + vega-lite spec validator (sandbox) | Spec is portable, no npm in sandbox |

`compatibility_date` is `2026-04-29` everywhere; `nodejs_compat`
flag enabled for Buffer / TLS work.

## Architecture quick map

```
                ┌───────────────┐
                │ Browser (web) │
                └───────┬───────┘
                        │ session cookie + WS
                        ▼
                ┌──────────────────┐
                │  api-gateway     │  Hono on Workers
                │  - Better Auth   │  - validates session
                │  - REST CRUD     │  - mints chat-token JWT (5 min)
                │  - WS upgrade    │  - reverse-proxies WS to chat-agent
                └────┬─────────┬───┘
                     │         │
            HS256 JWT│         │ Drizzle
            (chat-tok)        ▼
                     │   ┌───────────────────┐
                     ▼   │  Postgres (Neon)  │
        ┌────────────────│  control plane    │
        │                └───────────────────┘
        ▼
┌──────────────────────┐
│  chat-agent (DO)     │  one DO per chatId
│  ChatAgent : Think   │
│  - persists messages │
│  - presence + queue  │
│  - calls Workers AI  │
│  - codemode sandbox  │
│    └─ db.* tools ────┼──→ user's Postgres (read-only)
│    └─ chart.* + R2   │
└──────────────────────┘
```

Key invariants:

- **One DO per chat** — `name = chatId`. Cross-chat isolation via
  DO name routing.
- **DB profile creds never enter the sandbox.** The `db.query` tool
  runs in the DO's host worker; the sandbox calls it via codemode's
  capability binding. Decrypted creds live for the duration of one
  turn in DO memory, never on disk.
- **Defense-in-depth WS auth.** api-gateway validates session +
  membership + mints chat-token. chat-agent DO independently
  re-verifies the JWT in `onBeforeConnect` / `onBeforeRequest`.
  A leaked DO URL alone gets 401.
- **Turn FIFO.** `Think.messageConcurrency = "queue"` (default)
  serializes turns within a DO. Two users typing at once → second
  turn starts after first completes.

## Key files (by area)

### chat-agent

- `src/agent.ts` — the ChatAgent DO; ~1100 LOC. Override hooks:
  `beforeTurn` (rate-limit + turn-id stamp), `onChunk`, `onStepFinish`,
  `afterToolCall`, `onChatResponse`, `onChatError`, `onConnect`,
  `onClose`, `onMessage`. RPC methods (`@callable`):
  `debugDump`, `debugClearMessages`, `debugRateLimits`,
  `sandboxNetworkProbe`, `sandboxTimeoutProbe`.
- `src/index.ts` — Worker entry; `verifyChatToken` for WS upgrade
  before forwarding to `routeAgentRequest`. Returns 401 on missing
  token.
- `src/data-db.ts` — opens user's Postgres connection per turn.
  Connection cached on the DO (closed via DO hibernation, ~70s).
  Decrypts envelope-encrypted credentials.
- `src/system-prompt.ts` — builds the system prompt with chat
  context (db profile id, tenant id). Includes the
  "stop-when-answered" guidance.
- `src/tools/db-tools.ts` — `db.introspect`, `db.query`, `db.schema`.
  SQL safety: keyword allow-list + `transaction_read_only=on` +
  `statement_timeout=25s` + `LIMIT 5000` + 4 MiB byte cap.
- `src/tools/artifact-tools.ts` — `artifact.write*` saves to R2.
- `src/tools/vega-lite-tools.ts` — chart spec validation; ships only
  the validator + examples (no Vega-Lite npm in the sandbox).
- `src/tools/artifact-tools.ts` + `src/agent.ts` (chartTools) —
  `chart.bar`, `chart.line`, `chart.scatter` produce Vega-Lite
  artifacts.
- `src/audit.ts` — `auditFromAgent(env, event)`: opens max=1
  Postgres connection, closes via waitUntil.
- `src/rate-limits.ts` — pure `evaluatePolicy()` + Drizzle
  `checkRateLimits()`. Default windows: 50/chat/day, 20/user/hour,
  200/tenant/day. `RateLimitError.message` carries a structured
  envelope.
- `scripts/spike-*.ts`, `debug-*.ts`, `inspect-turn.ts` — operational
  tooling; see "Scripts" below.

### api-gateway

- `src/index.ts` — Hono root: structured request span middleware
  (logs `api.request`), closed-list CORS, mounts routers.
- `src/auth.ts` — Better Auth setup. `sendMagicLink` short-circuits
  silently for non-allowlisted email domains.
- `src/session.ts` — `requireSession()` middleware. Auto-provisions
  personal tenant + sample DB profile on first request. Closes
  Drizzle connection via 5s setTimeout in waitUntil (otherwise mid-
  middleware queries fail).
- `src/routes/ws.ts` — WS upgrade handler. Mints chat token, writes
  audit row, reverse-proxies via service binding.
- `src/routes/chats.ts` — chat CRUD + member management.
- `src/routes/db-profiles.ts` — DB profile CRUD; encrypts URL on
  write, decrypts on read (gated to owner).
- `src/routes/audit.ts` — read-only audit log endpoint for tenant
  admins.
- `src/audit.ts` — `writeAudit(db, event)` Drizzle helper.

### web

UI is shadcn/ui (style="new-york", base=neutral) on Tailwind v4.
Tokens live in `src/styles.css` as CSS variables (light + `.dark`
override) and are exposed to Tailwind via `@theme inline`. Use the
shadcn primitives in `src/components/ui/*` (Button, Input, Textarea,
Label, Dialog, Sheet, DropdownMenu, Select, Separator, Badge, Alert,
Card, Skeleton, ScrollArea, Tooltip) — do NOT hand-roll new
buttons/inputs. The `cn()` helper from `~/lib/utils` is the canonical
class-name composer.

- `src/components/ChatRoom.tsx` — main chat UI. `useAgentChat` from
  `@cloudflare/ai-chat/react` over WS. Renders codemode tool calls
  with Code/Result blocks, reasoning chips, presence badges, error
  banner via `toFriendlyError`. Tracks `wsOpen` + `hasInitialSync`
  (set on `cf_agent_messages` event) to gate skeleton vs real list.
  Mobile (sub-md) workspace lives in a Sheet via
  `WorkspaceSidebarBody`; desktop uses the permanent
  `WorkspaceSidebar` (md:flex w-72).
- `src/components/ArtifactViewer.tsx` — Vega-embed renderer + image
  fallback. Exports `resolveArtifactUrl` (prepends API URL to
  relative artifact paths). Has `fullWidth` prop: when true, drops
  the framing card and rewrites `width` to `"container"` for the
  vega spec — used inside the dialog. Theme-aware via
  `useTheme()` (re-renders on light/dark switch).
- `src/components/WorkspaceSidebar.tsx` — sidebar list of artifacts.
  Click opens an `ArtifactViewer fullWidth` inside a centered Dialog
  (max-w 900px) — earlier versions rendered a mini ArtifactViewer
  inside the 288px column which clipped chart titles. Exports
  `WorkspaceSidebarBody` for the mobile Sheet.
- `src/components/list-skeleton.tsx` — `ListSkeleton` reusable
  loading placeholder for divider lists (chats, connections,
  workspace). Pseudo-random row widths so the placeholder breathes.
- `src/components/theme-provider.tsx` — system / light / dark with
  manual override; stored in localStorage as `theme`. The
  `themeBootScript` constant is inlined into `<head>` from
  `__root.tsx` so the right `class="dark"` lands before Tailwind
  paints (no flash).
- `src/components/theme-toggle.tsx` — header dropdown showing
  resolved icon (sun/moon) + radio of system/light/dark.
- `src/components/ui/*` — shadcn primitives. Components are project
  source (committed); add new ones via `pnpm dlx shadcn add <name>`
  or by hand following the existing conventions. `components.json`
  documents the install config (alias `~/components/ui`).
- `src/lib/agent-error.ts` — `toFriendlyError` translates known
  error codes to banner shape; suppresses AbortError.
- `src/lib/api.ts` — typed fetch wrapper.
- `src/lib/auth-client.ts` — Better Auth client.
- `src/lib/utils.ts` — `cn()` (clsx + twMerge).
- `src/routes/__root.tsx` — server-side `__ENV__` injection
  (API_URL). Mounts `ThemeProvider` + `TooltipProvider`. Inlines
  the theme boot script before React hydrates.
- `src/routes/app.tsx` — app shell. Mobile hamburger opens a left
  Sheet with the nav; desktop shows nav inline. ThemeToggle in
  header.
- `src/routes/login.tsx` — magic link form. Uses absolute
  `callbackURL: "${origin}/app"` (relative resolves against API).

### shared

- `src/jwt.ts` — `mintChatToken` (HS256, 5 min) + `verifyChatToken`.
- `src/encryption.ts` — AES-GCM envelope (per-tenant DEK + master
  KEK). Used for DB profile URLs.
- `src/audit.ts` — `AuditEvent` type, `hashSql()`, `safePayload()`.
- `src/agent-error.ts` — `encodeAgentError` / `decodeAgentError`
  wire format (`DATA_AGENT_ERROR\n{json}`).
- `src/obs.ts` — `logEvent({ event, level?, ...fields })` JSON
  logger; `withSpan()` timer; `truncateMessage()`.
- `src/email.ts` — `sendEmail`: tries CF Email Sending binding
  first, REST fallback, console as last resort.

### db

- `src/schema.ts` — Drizzle tables: `user`, `session`, `account`,
  `verification`, `tenant`, `tenantMember`, `chat`, `chatMember`,
  `dbProfile`, `auditLog`.
- Migrations live in `packages/db/drizzle/`.

## Conventions

### Logging

Every diagnostic log goes through `logEvent` from
`@data-agent/shared`. **Don't `console.log/warn/error` directly.**
Pattern:

```ts
logEvent({
  event: "chat.turn_start",     // stable kebab.dotted name
  level: "info",                 // optional, defaults to info
  chatId: this.name,
  turnId,
  // any other structured fields
});
```

Workers Logs auto-indexes JSON lines, so every field is filterable
in the dashboard. Stable event names (so saved queries don't break):

| Event | Source | When |
|--|--|--|
| `api.request` | api-gateway | every request (status, durationMs, userId) |
| `audit.write_failed` | both | audit insert threw |
| `chat.auth_failed` | chat-agent | invalid/missing chat token |
| `chat.context_resolve_failed` | chat-agent | control-plane fetch failed in beforeTurn |
| `chat.turn_start` | chat-agent | beforeTurn |
| `chat.turn_step` | chat-agent | per AI SDK step |
| `chat.turn_chunk` | chat-agent | per chunk (sampled 1/50 + non-text-delta) |
| `chat.tool_call` | chat-agent | every tool call |
| `chat.turn_complete` | chat-agent | onChatResponse |
| `chat.turn_error` | chat-agent | onChatError |
| `chat.ws.connect` | chat-agent | onConnect |
| `chat.ws.close` | chat-agent | onClose |
| `chat.title_summarize_start` | chat-agent | first user message → fire-and-forget summarizer enters |
| `chat.title_summarized` | chat-agent | auto-title saved + broadcast |
| `chat.title_summarize_failed` | chat-agent | model err / sanitize reject / race lost / persist err |
| `ws.upgrade` / `ws.upgrade_response` / `ws.upgrade_failed` | api-gateway | WS reverse-proxy boundary |

Every chat-agent event carries a `turnId` (for in-turn events) or
`chatId` (always). To trace a single turn end-to-end, filter
`turnId = "t_xxxx"` in Workers Logs.

### Audit log

`audit_log` table is the durable record. Best-effort: every write is
fired via `c.executionCtx.waitUntil(writeAudit(...))` (gateway) or
`this.ctx.waitUntil(auditFromAgent(...))` (chat-agent). A failed
audit row never blocks a user request — but it does emit an
`audit.write_failed` log event so it's not silent.

Actions: `chat.create`, `chat.delete`, `chat.member.*`,
`chat.title.auto`, `db_profile.create`, `db_profile.delete`,
`chat.ws.connect`, `turn.start`, `turn.complete`, `turn.error`,
`db.query`, `tool.<name>`, `artifact.read`.

`audit_log` doubles as the rate-limit counter store
(`turn.start` rows). Acceptable for alpha; post-alpha move to KV.

### Errors

- **Anticipated** failures (rate limit, sandbox timeout, SQL error,
  auth) throw `Error(encodeAgentError({code, message, details}))`.
  The web client decodes via `toFriendlyError` and renders a
  context-aware banner.
- **Unanticipated** failures land in the generic "Something went
  wrong" banner. Log them — never echo raw stack traces in the UI.
- **Aborts** (`AbortError`, message contains "aborted") return null
  from `toFriendlyError`. Aborts mean the WS dropped or the user
  canceled; the partial work is preserved server-side and the
  agents SDK auto-resumes via `cf_agent_stream_resume_request`.

### Naming

- Events: `kebab.dotted` (e.g. `chat.turn_start`).
- Audit actions: `domain.verb` (e.g. `chat.create`, `db.query`).
- Error codes: `snake_case` (e.g. `rate_limit_chat_daily`).
- Tool names: `snake_case` for AI SDK schema; codemode sanitizes
  dots to underscores.
- TS: camelCase. Files: `kebab-case.ts`. React components:
  `PascalCase.tsx`.

### Comments

Comments in this codebase explain **why**, not what. If it took
more than 5 seconds to figure out, leave a comment with the
*reason* the code is shaped the way it is. Past-tense
("Earlier code did X but Y broke") is welcome. We've explicitly
captured several drift-prone bits this way (CORS reflectivity,
statement-timeout 25s vs 30s, transaction_read_only enforcement,
session connection-close 5s setTimeout).

### Testing

- Unit tests next to source: `foo.ts` + `foo.test.ts`. Vitest.
- Integration via `scripts/spike-*.ts` — run via
  `pnpm --filter @data-agent/<pkg> exec tsx scripts/spike-X.ts`.
- 82+ unit tests as of this writing.

### Secrets

All in CF Secrets Store (binding `secrets_store_secrets`). Never
hardcode. `readSecret(env.NAME)` resolves the binding to a string;
caches per-DO instance. Local dev uses `.dev.vars`. Don't put
non-secrets in there — use `vars` in `wrangler.jsonc` for those.

## Common tasks

### Add a new tool

1. Define a Zod schema + handler in
   `packages/chat-agent/src/tools/<area>-tools.ts`.
2. Export an object with the tool: `{ "tool_name": tool({...}) }`.
3. Wire it into the agent's tool merge in `agent.ts`'s tool
   assembly. Codemode and AI-SDK tool surfaces are merged.
4. Update `system-prompt.ts` to mention it (one line is fine).
5. Add a unit test if it has any nontrivial logic.

### Add a new env var

1. Add to `Env` interface (`packages/<pkg>/src/env.ts`).
2. For non-secret: add to `vars` in `wrangler.jsonc`. Local dev:
   `.dev.vars`.
3. For secret: add to `secrets_store_secrets` in `wrangler.jsonc`,
   create the secret in CF Secrets Store, populate `.dev.vars` for
   local. Use `readSecret(env.X)` to read.

### Add a new audit action

1. Coin a `domain.verb` name. Document in `AGENTS.md` table above.
2. Call `writeAudit` (api-gateway) or `auditFromAgent` (chat-agent)
   with the new action. Always inside `waitUntil`. Use
   `safePayload(payload, 4096)` if the payload could be large.

### Add a new structured log event

1. Coin a `kebab.dotted` event name. Document in this file.
2. `logEvent({ event, ...fields })`. Always include `chatId` if
   applicable; include `turnId` if you're inside a turn.

### Bump CPU / wall clock

`limits.cpu_ms` in `wrangler.jsonc`. Currently 300_000 (5 min)
on chat-agent + api-gateway. **Do not lower.** DO wall is
unlimited while WS is open, but CPU still counts; long multi-step
turns chew through CPU cap before they chew through wall.

### Investigate a failed chat turn

```
pnpm --filter @data-agent/chat-agent exec tsx scripts/inspect-turn.ts <chatId>
```

Gives you the audit timeline + turnIds. Then in Workers Logs
dashboard for `data-agent-chat-agent`, filter `turnId = "<id>"` to
see every chat.turn_start / turn_step / turn_chunk / tool_call /
ws.close / turn_complete / turn_error.

If the user reports it: ask them for the **browser console log** of
the chat-room WS lifecycle. The web client logs structured close
events with codeLabel (1001=tab closed, 1006=network flap, etc),
sessionMs, document.visibilityState, and navigator.onLine.

### Clear a stuck chat

The Think message store can end up with `state: "streaming"` parts
that never finished (e.g. on abnormal abort). UX shows endless
"thinking". Recovery:

```
pnpm --filter @data-agent/chat-agent exec tsx scripts/debug-clear.ts <chatId>
```

Calls the `debugClearMessages` RPC on the DO and wipes its message
history. New turns work fine.

## Operational scripts

All in `packages/chat-agent/scripts/` unless noted. Run via
`pnpm --filter @data-agent/chat-agent exec tsx scripts/<name>.ts`.

| Script | Use |
|--|--|
| `inspect-turn.ts <chatId>` | Audit timeline + turnIds for a chat |
| `debug-chat.ts <chatId>` | Dump full DO state (messages, presence, ctx) |
| `debug-clear.ts <chatId>` | Wipe DO message history |
| `debug-rate-limits.ts` | Inspect current rate-limit counts |
| `spike.ts` | Minimal Think + codemode end-to-end probe |
| `spike-db.ts` | DB-tools probe against a real DB |
| `spike-artifacts.ts` | Artifact write/read round-trip |
| `spike-sandbox.ts` | T1 verifier: network/timeout probes |
| `spike-audit.ts` | audit_log integration smoke test |

In `packages/api-gateway/scripts/`:
| `spike-audit.ts` | gateway-side audit_log smoke test |

All spike scripts speak to the **deployed** workers via internal
JWTs (env: `INTERNAL_JWT_SIGNING_KEY` from `.dev.vars`). They are
the closest thing we have to integration tests.

## Performance / resource caps

| Limit | Value | Where enforced |
|--|--|--|
| Sandbox CPU/wall | 30 s | `DynamicWorkerExecutor.timeout` |
| Sandbox network | None | `globalOutbound: null` |
| SQL statement timeout | 25 s | `SET LOCAL statement_timeout` |
| SQL read-only | server-side | `SET LOCAL transaction_read_only` |
| SQL rows | 5,000 | `LIMIT N+1` post-query |
| SQL bytes | 4 MiB | byte-counting in `db.query` |
| Turns/chat/day | 50 | `rate-limits.ts` |
| Turns/user/hour | 20 | `rate-limits.ts` |
| Turns/tenant/day | 200 | `rate-limits.ts` |
| Output tokens/turn | 8,192 | Workers AI request param |
| Worker CPU/request | 300 s | `limits.cpu_ms` in wrangler |
| Chat token TTL | 5 min | `mintChatToken` default |
| LLM $-budget | configurable | CF AI Gateway dashboard |

## Subtask history (`d7943e`)

All 36 subtasks shipped. The names are stable references in commit
messages:

```
776325 monorepo       9c2659 CI            a636fe CF account
93f695 Neon+Drizzle   3c8c0b api-gateway   616db2 ChatAgent DO
fde638 web app        6c7414 Better Auth   5d7e7d magic-link UI
4cd388 chat token     c97933 schema        f0a0e9 envelope encryption
b75305 db-profile CRUD b1f5fd chat CRUD    1b9bc9 SPIKE
e1a679 WS upgrade     382d1f persistence   5ea868 Postgres in DO
039ac8 db.* tools     5038e4 chart.* + artifact.*  abe549 vega-lite
ef7df2 AI SDK polish  64c889 system prompt fa583c Chat UI
a4e12f artifact viewer 19183b sidebar      46391e presence + queue
dea3ff multi-user UX  2173ac sandbox harden 1dd311 audit logging
947c38 rate limiting  5bcb5f cost (AI Gw)  2f89ff error UX
9fa055 observability  dc09a3 internal alpha c87874 security review
```

Ground truth: `todo show d7943e`.

## Decisions log (high-impact)

These are non-obvious decisions that affect *how to extend* the
project. Don't undo without reading the relevant context.

1. **AI Gateway over hand-rolled cost tables.** `5bcb5f`. CF
   dashboard owns price math; we just attach metadata
   (tenantId/chatId/userId) so it can slice. Pricing changes don't
   need code deploys.
2. **`messageConcurrency: "queue"` (default).** FIFO turn lock
   per DO. Don't switch to interleave without a multi-user UX rework.
3. **`chatRecovery: true` (default).** Think wraps each turn in a
   fiber for durability. Adds a bit of overhead; gives us
   stash/resume.
4. **Source-export `shared`.** Faster dev cycle, but you must
   `pnpm --filter @data-agent/shared build` after adding exports.
5. **No PII redaction in audit payloads.** Documented non-goal.
   Owners are responsible for what goes in their DB.
6. **Closed-list CORS.** `c87874` P0 finding. Reflective + creds
   was a credential-leak vector. Don't reintroduce.
7. **`transaction_read_only = on`** as second-line defense after
   SQL keyword regex. `c87874` P1 finding. Postgres-native, can't
   be bypassed inside the transaction.
8. **`STATEMENT_TIMEOUT_MS = 25_000`** (not 15s). Matches sandbox
   30s wall with ~5s overhead margin (cold pool / TLS / parse).
9. **5s setTimeout for connection-close** in api-gateway middleware
   waitUntil. Hono runs middleware sequentially; closing the
   Drizzle connection synchronously kills mid-flight queries from
   the next handler.
10. **Single-origin web + api on `data-agent.dkzlv.com`.** Web
    Worker owns the Custom Domain; api-gateway is a Route at
    `/api/*` + `/healthz` on the same hostname (CF Routes take
    precedence over Custom Domains for matching paths). Cookie is
    host-only + SameSite=Lax + Secure + httpOnly — no `Domain`
    attribute. Earlier alpha mounted api-gateway at
    `api.data-agent.dkzlv.com` with `Domain=.data-agent.dkzlv.com`
    on the cookie. Brave Shields' ephemeral-storage partitioning
    treated the apex↔subdomain hop as cross-site and dropped the
    cookie on cross-tab navigation, surfacing as a Chromium
    `ERR_BLOCKED_BY_RESPONSE` "HTTP ERROR 403" net-error page on
    `/app`. Same-origin removes the cross-site surface entirely
    (no CORS, no preflights, no partitioning).
11. **Codemode wraps tool returns in `{code, result: ...}`.**
    Web client's `asArtifactRef` peeks at `value.result` so
    chart artifacts render inline.
12. **Auto-seed sample DB on first sign-in.** `session.ts`
    `seedSampleDbProfile` provisions a read-only Neon employees DB
    so every new tenant has something to chat with immediately.
13. **Magic-link allow-list is silent.** No enumeration. Default
    `indent.com`; configurable via `ALLOWED_EMAIL_DOMAINS`.
14. **Stop-when-answered prompt nudge.** Kimi K2.6 likes to keep
    iterating; prompt explicitly says "after an artifact saves,
    write the final reply immediately."
15. **Inline `waitUntil` for title summarization** (subtask 16656a).
    Auto-titling fires from `beforeTurn` on the first user message
    via `ctx.waitUntil(summarizeAndPersistTitle(...))` — same pattern
    as audit/cost writes. We considered a CF Queue + consumer worker
    but the win (decoupled retry, separate quota) doesn't justify a
    new binding for a one-off, best-effort, single-call workload.
    Race-guarded persist (`WHERE title_auto_generated = true AND
    title = 'New chat'`) means a manual rename always wins, so
    losing the model call is a no-op. **Important:** the
    summarizer call passes `chat_template_kwargs.enable_thinking
    = false` and `reasoning_effort = "low"` — the chat path enables
    thinking by default and on Kimi K2.6 those reasoning tokens
    consume the entire 64-token output budget before any title
    text is emitted. Earlier the chat list silently never updated
    away from "New chat" because of this; don't undo without
    bumping `maxOutputTokens` substantially.
16. **Cached session gate on `/app`.** `app.tsx` `beforeLoad` runs on
    every intra-app navigation by default, and our auth check is a
    network call to better-auth's `/get-session`. The earlier setup
    re-hit that endpoint on every nav and TanStack Router unmounted
    the previous match while waiting, which surfaced as a flash of
    white (papercut). We memoize the session check in a
    module-scoped promise (`sessionGate`) so it resolves once per
    page load. The api-gateway is still the authoritative gate —
    every data fetch re-validates the cookie server-side, so the
    cached client-side gate doesn't widen the auth surface.

## Anti-patterns to avoid

- **`console.log` for diagnostics.** Use `logEvent`.
- **Synchronous credential decryption inside the sandbox.** Creds
  must never enter the Worker Loader isolate.
- **New audit actions without documenting them here.**
- **Bumping `cpu_ms` past 300_000.** That's the platform max for
  HTTP triggers anyway.
- **Adding network-touching imports to `globalOutbound: null`
  modules.** The Worker Loader rejects them at load time but
  better to avoid the rebuild churn.
- **Logging raw SQL.** Use `hashSql()` from
  `@data-agent/shared/audit`.
- **Echoing error.message to the UI without `toFriendlyError`.**
  Stack traces leak internals.
- **Forgetting to rebuild shared after changing exports.** TS
  consumers will see the stale `dist/`.
- **Deploying without running tests.** `pnpm -r run test` is fast
  (sub-second across the whole workspace).

## When in doubt

- Audit timeline → `inspect-turn.ts <chatId>`
- DO state → `debug-chat.ts <chatId>`
- Live logs → `wrangler tail --name data-agent-<service>`
- Past logs → CF dashboard → Workers Logs (search by event/turnId)
- AI Gateway logs → CF dashboard → AI Gateway → `data-agent`
- The threat model → `SECURITY.md`
- Why is this code shaped weirdly → look at the comment above it,
  there usually is one
