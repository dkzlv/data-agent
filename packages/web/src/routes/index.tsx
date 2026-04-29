import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { ThemeToggle } from "~/components/theme-toggle";

export const Route = createFileRoute("/")({
  component: HomeRoute,
});

function HomeRoute() {
  return (
    <main className="relative mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          data-agent · pre-alpha
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          A BI agent for your Postgres.
        </h1>
        <p className="max-w-md text-pretty text-muted-foreground">
          Connect a database. Ask questions. Get charts. Multiplayer.
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app">Open app</Link>
        </Button>
      </div>
    </main>
  );
}
