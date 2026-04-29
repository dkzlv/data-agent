# data-agent

A BI agent on Cloudflare. Bring your own Postgres, chat with an LLM, get answers and charts back. Multi-user chats per database.

Runs entirely on Cloudflare's developer platform: Workers, Durable Objects, R2, Workers AI (Kimi K2.6), Worker Loader (Code Mode sandbox), and Email Sending.

## Workspace

```
packages/
  shared/       # types, JWT helpers, encryption helpers
  db/           # Drizzle schema + migrations (control-plane Postgres)
  api-gateway/  # CF Worker: HTTP/WS routing, Better Auth handler
  chat-agent/   # CF Worker: ChatAgent DO + Code Mode + tools
  web/          # TanStack Start app
```

## Scripts

```
pnpm typecheck       # tsc --build across the workspace
pnpm lint            # oxlint
pnpm format          # biome format --write
pnpm format:check    # biome format (check only)
pnpm dev             # start all dev servers
pnpm build           # build everything
pnpm test            # vitest
```

## Tooling

- **pnpm 10** workspaces
- **TypeScript 5.9** project references, strict mode, `noUncheckedIndexedAccess`
- **oxlint** — fast linter
- **biome** — formatter only
- **lefthook** — git hooks (format + lint pre-commit, typecheck pre-push)
- **wrangler** — Worker dev/deploy

## Status

Pre-alpha. See `CONTINUE.md` for active task tracking and decisions log.
