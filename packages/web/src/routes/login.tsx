import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Magic-link form lands in subtask 5d7e7d.
      </p>
    </main>
  );
}
