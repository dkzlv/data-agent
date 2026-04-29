/**
 * /app/welcome — first-run experience.
 *
 * The auth gate is inherited from the parent `/app` route. We
 * additionally redirect away if the user already has chats so
 * returning users never see this page (they go straight to the
 * chats list). Two CTAs: start a demo chat against the auto-seeded
 * sample DB (one click), or connect their own Postgres.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ArrowRight, Database, Sparkles } from "lucide-react";
import { chatsApi, dbProfilesApi } from "~/lib/api";
import { findSampleProfile } from "~/lib/sample-db";
import { Button } from "~/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Skeleton } from "~/components/ui/skeleton";
import { AppMobileNavTrigger, AppPageScroll } from "~/routes/app";

export const Route = createFileRoute("/app/welcome")({
  component: WelcomeRoute,
});

function WelcomeRoute() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });

  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
  });

  // Bounce returning users straight to the chat list. We do this in
  // an effect (rather than a router `loader`) to avoid an extra
  // round-trip on first paint; the brief flash is acceptable for an
  // already-rare path (returning user lands on /app/welcome only via
  // direct nav).
  useEffect(() => {
    if (chats.data && chats.data.length > 0) {
      navigate({ to: "/app", replace: true });
    }
  }, [chats.data, navigate]);

  const sample = profiles.data ? findSampleProfile(profiles.data) : undefined;

  const startDemo = useMutation({
    mutationFn: () => {
      if (!sample) throw new Error("Sample database not available.");
      return chatsApi.create({ dbProfileId: sample.id });
    },
    onSuccess: ({ chat }) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      navigate({ to: "/app/chats/$chatId", params: { chatId: chat.id } });
    },
  });

  const isLoading = chats.isLoading || profiles.isLoading;

  return (
    <AppPageScroll>
    <div className="mx-auto max-w-3xl space-y-8 py-6 sm:py-10">
      <div className="md:hidden">
        <AppMobileNavTrigger />
      </div>
      <header className="space-y-2 text-center sm:text-left">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Welcome to data-agent.
        </h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          Ask questions about a Postgres database in plain English. Try the demo or connect your
          own.
        </p>
      </header>

      {isLoading ? (
        <WelcomeSkeleton />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <article className="flex flex-col rounded-lg border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-4 w-4" />
              <p className="text-xs font-semibold uppercase tracking-wide">Demo</p>
            </div>
            <h2 className="mt-3 text-lg font-semibold tracking-tight">Try the demo DB</h2>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">
              Read-only sample of an employees database — salaries, departments, hire dates. No
              setup required.
            </p>
            {!sample && profiles.data ? (
              <Alert variant="warn" className="mt-4">
                <AlertTitle>Demo unavailable</AlertTitle>
                <AlertDescription>
                  We couldn't find the sample database for your tenant. You can{" "}
                  <Link to="/app/db-profiles" className="underline underline-offset-2">
                    add a connection
                  </Link>{" "}
                  to get started.
                </AlertDescription>
              </Alert>
            ) : (
              <Button
                className="mt-4 w-full sm:w-auto sm:self-start"
                onClick={() => startDemo.mutate()}
                disabled={!sample || startDemo.isPending}
              >
                {startDemo.isPending ? "Starting…" : "Start a demo chat"}
                {!startDemo.isPending && <ArrowRight className="h-4 w-4" />}
              </Button>
            )}
            {startDemo.error && (
              <p className="mt-2 text-xs text-destructive">{(startDemo.error as Error).message}</p>
            )}
          </article>

          <article className="flex flex-col rounded-lg border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Database className="h-4 w-4" />
              <p className="text-xs font-semibold uppercase tracking-wide">Bring your own</p>
            </div>
            <h2 className="mt-3 text-lg font-semibold tracking-tight">Connect your Postgres</h2>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">
              Read-only URL, encrypted at rest. Takes 30 seconds.
            </p>
            <Button variant="outline" className="mt-4 w-full sm:w-auto sm:self-start" asChild>
              <Link to="/app/db-profiles">
                Add a connection
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </article>
        </div>
      )}

      {chats.data && chats.data.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground sm:text-left">
          <Link to="/app" className="underline underline-offset-2">
            Already have chats? View them →
          </Link>
        </p>
      ) : null}

      {chats.error && (
        <Alert variant="destructive">
          <AlertDescription>{(chats.error as Error).message}</AlertDescription>
        </Alert>
      )}
      {profiles.error && (
        <Alert variant="destructive">
          <AlertDescription>{(profiles.error as Error).message}</AlertDescription>
        </Alert>
      )}
    </div>
    </AppPageScroll>
  );
}

function WelcomeSkeleton() {
  // Mirror the resolved layout (two cards side-by-side) so the
  // welcome screen doesn't pop when chats/profiles resolve.
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Loading">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6 shadow-sm"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="mt-2 h-9 w-36" />
        </div>
      ))}
    </div>
  );
}
