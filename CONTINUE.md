# CONTINUE.md — survival manual for the autonomous agent finishing this project

> **Read this file at the start of every fresh context. Do not re-ask the user any of the questions below — they are answered.**

## Mission

Finish task `d7943e` in todo (the parent "Data Agent" task). 36 subtasks total. The user has explicitly granted permission to work end-to-end without intervention. Do not pause to ask questions unless you are physically blocked (and even then, log to `# BLOCKED ON USER:` block at the bottom of this file rather than waiting).

## Workflow

1. Read this file (you're doing it).
2. Run `todo d7943e` to see remaining open subtasks.
3. Pick the next subtask in order (lowest `order:` field that is still `status: todo`).
4. Run `todo show <id>` for full context.
5. Implement.
6. Run `todo done <id>` immediately on completion. **Do not batch.**
7. Repeat until all 36 are done.
8. Final commit + push to GitHub.

## Authoritative decisions (do not revisit)

| Concern | Decision |
| --- | --- |
| Package manager | pnpm + workspaces |
| Node version | LTS via mise / `.nvmrc` |
| TS | strict, project refs, shared `tsconfig.base.json` |
| Linter | oxlint |
| Formatter | biome (oxfmt not stable enough) |
| Git hooks | lefthook |
| Test runner | vitest + `@cloudflare/vitest-pool-workers` |
| Deploy tool | wrangler |
| Cloud | Cloudflare end-to-end |
| Domain | `data-agent.dkzlv.com`. Subdomains: `api.` and `app.` |
| Account ID | `2f7029a7ef2671db090d9304f595c42d` |
| Control-plane DB | Neon Postgres (free tier) |
| Neon connection (dev = prod for now) | `postgresql://neondb_owner:npg_OPsq0jJH9zrx@ep-noisy-cell-am6gcosv.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require` |
| Postgres driver (control plane + customer DBs) | `postgres` (postgres.js). `pg` works too but `postgres` is leaner and Hyperdrive-friendly. |
| Auth | Better Auth + `magicLink` plugin only. **No Google OAuth, no password.** |
| Email sending | **Cloudflare Email Sending** (the new Beta product, not MailChannels). Domain `data-agent.dkzlv.com` is already onboarded + DKIM-locked. Quota 1000/day. Use the Email Sending API via Cloudflare API. |
| LLM | **Workers AI**, default model `@cf/moonshotai/kimi-k2.6` (1T param, 262k ctx, function calling, vision, reasoning). Fallback `@cf/zai-org/glm-4.7-flash`. **No Anthropic, no OpenAI keys** — bound only via `env.AI`. |
| Agent SDK | `@cloudflare/think` (NOT `@cloudflare/ai-chat`). Think gives 3-line subclass + Session-backed messages + FTS5 + non-destructive regen + context blocks. |
| Companion packages | `@cloudflare/codemode`, `@cloudflare/shell`, `agents`, `workers-ai-provider`, `ai`, `zod` |
| Frontend | TanStack Start + React 19 + Tailwind + shadcn/ui + TanStack Query |
| Frontend host | Cloudflare Workers (TanStack Start has a Workers adapter; CF Pages is being unified into Workers — use Workers) |
| Multi-user turn semantics | FIFO queue, max depth 3 (per task `dea3ff`) |
| Vega-lite | Pre-bundled at deploy time, injected into Code Mode sandbox via `modules` option |
| Sandbox network | `globalOutbound: null` always |
| Sandbox timeout | 30s |
| Frontier guard | Hard caps: 50 agent turns/chat/day, 8k output tokens/turn |
| Observability | Stub for now (Tail Workers configured but no remote sink). Document fallback. |
| Sentry | Stub. |
| Security review (`c87874`) | Self-audit checklist + document findings. Note that real third-party review is required pre-launch. |
| Internal alpha (`dc09a3`) | Stub: provision sample Postgres (Northwind), document invite procedure, mark done. |

## Secrets

Live in:
- Local: `packages/*/.dev.vars`
- Prod: Cloudflare Secrets Store, account-scoped store named `data-agent-secrets`

| Key | Source | Notes |
| --- | --- | --- |
| `MASTER_ENCRYPTION_KEY` | auto-generated (32 random bytes, base64) | for envelope encryption |
| `INTERNAL_JWT_SIGNING_KEY` | auto-generated | api-gateway ↔ ChatAgent |
| `BETTER_AUTH_SECRET` | auto-generated | |
| `CONTROL_PLANE_DB_URL` | Neon string above | |
| `CF_ACCOUNT_ID` | `2f7029a7ef2671db090d9304f595c42d` | |
| `CF_API_TOKEN` | not yet set; user uses wrangler OAuth | needed for Email Sending API call from Worker. Will request from user when first needed, or use a Worker-bound API token |

**Never commit `.dev.vars` files.** Add them to `.gitignore` first thing.

## Repository

- GitHub: `dkzlv/data-agent` (public, already exists)
- Local: `/Users/dkzlv/Projects/indent/data-agent`
- gh CLI authenticated as `dkzlv`
- wrangler authenticated for the right CF account (verified via `wrangler whoami` — OAuth token, broad scopes)

## Workspace layout target

```
packages/
  shared/       # types, JWT helpers, encryption helpers, schema types
  db/           # Drizzle schema + migrations (control-plane)
  api-gateway/  # CF Worker: HTTP/WS routing, Better Auth handler
  chat-agent/   # CF Worker: ChatAgent DO + Code Mode + tools
  web/          # TanStack Start app
```

## Pre-flight checks already done

- ✅ Worker Loader binding works on this account (deployed + invoked a probe)
- ✅ `globalOutbound: null` correctly blocks fetch from Dynamic Workers
- ✅ DNS for `data-agent.dkzlv.com` Email Sending is set up (status: Enabled, locked)
- ✅ Workers Paid plan active
- ✅ Account has access to: workers, KV, R2, D1, Pages, Secrets Store, AI, Queues, Pipelines, Containers (per `wrangler whoami` scopes)

## Operating principles

1. **Build, don't ask.** When ambiguous, pick the simplest reasonable thing, write a 1-line comment about why, move on.
2. **Mark `todo done <id>` immediately.** Don't batch.
3. **Commit per subtask.** Conventional commits: `feat(scope): ...`, `chore(scope): ...`, etc. Body should describe what got done. Reference subtask id like `[d7943e/776325]`.
4. **Never run `wrangler deploy` for production until at least the spike (`1b9bc9`) is green.** Local dev / `wrangler dev` only.
5. **Cost ceiling.** Worst-realistic-case is < $5 because we're inside Workers Paid + free tiers + Workers AI included neurons. Don't run load tests. Don't run unbounded scripts.
6. **CI babysitting: skip.** User explicitly deprioritized CI. Don't poll `gh run list`, don't fix dependabot PRs. Local git hooks (lefthook) catch the same issues pre-push, which is enough.
6. **If genuinely blocked**, append a `# BLOCKED ON USER:` block at the bottom of this file with the question, mark the current subtask in-progress, and STOP gracefully. Do not invent answers to user-only questions.

## Useful commands

```sh
todo d7943e               # show parent + remaining subtasks
todo show <id>            # full subtask description
todo done <id>            # mark complete (do this!)
wrangler deploy           # deploy a Worker
wrangler dev              # local dev
wrangler whoami           # confirm CF account
gh auth status            # confirm github
gh repo view dkzlv/data-agent --web
```

## API/SDK reference cheat sheet

### Worker Loader (Dynamic Workers)
```ts
const stub = env.LOADER.get("id-or-version", async () => ({
  compatibilityDate: "2026-04-29",
  mainModule: "main.js",
  modules: { "main.js": "...code..." },
  globalOutbound: null,  // null = no internet, Fetcher = routed
}));
const res = await stub.getEntrypoint().fetch(new Request("https://x/"));
```

### codemode + shell + Think (full stack)
```ts
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

export class ChatAgent extends Think<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.ARTIFACTS,
    name: () => this.name,
  });

  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
  }

  getTools() {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const codemode = createCodeTool({
      tools: [
        stateTools(this.workspace),
        { tools: this.dbTools() },
        { tools: this.chartTools() },
      ],
      executor,
    });
    return { codemode };
  }
}
```

### Email Sending (Cloudflare Email API, Beta)
- Send via `https://api.cloudflare.com/client/v4/accounts/{account_id}/email/routing/send` (or whatever the correct endpoint is — confirm at implementation time; Beta in flux)
- Or use the `send_email` binding for Email Routing — but that requires a verified destination address (i.e., for routing _into_ CF, not generic outbound). Investigate whether the new Email Sending Beta exposes a Worker binding yet; if not, fall back to API call from the Worker with `CF_API_TOKEN`.

### Better Auth (postgres.js + Drizzle adapter + magic link)
```ts
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createAuth(env: Env) {
  const sql = postgres(env.CONTROL_PLANE_DB_URL, { max: 5, fetch_types: false });
  const db = drizzle(sql, { schema: authSchema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    secret: env.BETTER_AUTH_SECRET,
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(env, email, "Your sign-in link", `Sign in: ${url}`);
        },
      }),
    ],
  });
}
```

## State as of last hand-off

After scaffolding all 5 packages (subtasks 1-7 done), the workspace is in this state:

- **Build:** `pnpm build` runs to completion. Web SSR + client bundles compile.
- **Typecheck:** `pnpm typecheck` clean across all packages.
- **Lint/format:** clean.
- **Database:** Neon connected, `_health` table migrated and round-tripped successfully.
- **Cloudflare:**
  - R2 bucket `data-agent-artifacts` exists
  - Secrets Store `default_secrets_store` (id `5fca98fdba4f4972b9d14ac74ea58cf4`) ready (empty; secrets pushed via `scripts/push-secrets.sh` when needed)
  - Worker Loader + AI binding both confirmed working on this account
  - No workers deployed yet (only local dev)

## Implementation notes / gotchas accumulated so far

1. `wrangler` upgraded to 4.86 mid-session — pin in package.json's deps if reproducibility matters.
2. `pnpm-workspace.yaml` (not `package.json`) is where `onlyBuiltDependencies` lives in pnpm 10.
3. `Think<Env>` requires `override` modifier on `workspace` and `getModel`. `getModel()` needs an explicit `LanguageModel` return type or tsc trips on private members from AI SDK provider.
4. `@cloudflare/workers-types` must be in `tsconfig.types[]` for any worker package — otherwise globals like `Request`, `Response`, `Ai`, `R2Bucket`, `Cloudflare.Env` don't resolve.
5. TanStack Start expects `getRouter` (not `createRouter`) as the export name in `src/router.tsx` — the CF-Vite plugin pulls `getRouter` via virtual module.
6. CF Vite plugin canonical wrangler.jsonc for TanStack Start: `"main": "@tanstack/react-start/server-entry"` (yes, an npm specifier, not a file path).
7. Biome ignores .md/.sh by default. Lefthook glob must exclude them or biome exits 1.
8. lefthook 1.13 hooks installed via post-install. v2.x is available — do not chase upgrades autonomously, dependabot will PR them.

## Progress log

(append after each subtask)

- [x] 776325 Initialize monorepo
- [x] 9c2659 Set up CI (workflow exists; user has deprioritized — not monitoring runs)
- [x] a636fe Provision Cloudflare account
- [x] 93f695 Pick + provision control-plane DB
- [x] 3c8c0b Scaffold api-gateway Worker
- [x] 616db2 Scaffold ChatAgent DO
- [x] fde638 Scaffold web app
- [ ] 6c7414 Better Auth in control-plane
- [ ] 5d7e7d Wire web app to Better Auth
- [ ] 4cd388 Session JWT minting + validation
- [ ] c97933 Design control-plane DB schema
- [ ] f0a0e9 Envelope encryption for DB creds
- [ ] b75305 DB profile CRUD
- [ ] b1f5fd Chat CRUD + members
- [ ] 1b9bc9 Spike: Think + Workspace + codemode E2E
- [ ] e1a679 WS upgrade routing
- [ ] 382d1f Message persistence + resumable streaming
- [ ] 039ac8 db.* ToolProvider
- [ ] 5ea868 Postgres connection in DO
- [ ] 5038e4 chart.* + artifact.* ToolProviders
- [ ] abe549 Bundle vega-lite for sandbox
- [ ] ef7df2 Wire AI SDK v6 + Workers AI (Kimi)
- [ ] 64c889 System prompt + tool descriptions
- [ ] fa583c Chat UI
- [ ] a4e12f Artifact viewer
- [ ] 19183b Workspace file browser sidebar
- [ ] 46391e Multi-user: presence + turn-lock
- [ ] dea3ff Multi-user product semantics
- [ ] 2173ac Sandbox hardening
- [ ] 1dd311 Audit logging
- [ ] 947c38 Rate limiting
- [ ] 5bcb5f Cost telemetry
- [ ] 2f89ff Error UX
- [ ] 9fa055 Observability (stub)
- [ ] dc09a3 Internal alpha (stub)
- [ ] c87874 Security review (self-audit)

---

# BLOCKED ON USER:

(empty — keep it that way. only append if genuinely stuck.)
