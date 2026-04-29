import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-widest text-neutral-500">
          data-agent · pre-alpha
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">A BI agent for your Postgres.</h1>
        <p className="max-w-md text-pretty text-neutral-600 dark:text-neutral-400">
          Connect a database. Ask questions. Get charts. Multiplayer.
        </p>
      </header>

      <div className="flex gap-3">
        <Link
          to="/login"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Sign in
        </Link>
        <Link
          to="/app"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Open app
        </Link>
      </div>
    </main>
  );
}
