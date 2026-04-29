import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const session = await authClient.getSession();
    if (!session.data?.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: AppShell,
});

function AppShell() {
  async function handleSignOut() {
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-200 bg-white/60 px-4 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/60">
        <div className="flex items-center gap-6">
          <Link to="/app" className="font-mono text-xs uppercase tracking-widest text-neutral-500">
            data-agent
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link
              to="/app"
              activeOptions={{ exact: true }}
              className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 [&.active]:text-neutral-900 [&.active]:dark:text-neutral-100"
            >
              Chats
            </Link>
            <Link
              to="/app/db-profiles"
              className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 [&.active]:text-neutral-900 [&.active]:dark:text-neutral-100"
            >
              Connections
            </Link>
          </nav>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          Sign out
        </button>
      </header>
      <main className="flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
