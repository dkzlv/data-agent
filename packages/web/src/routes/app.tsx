import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app")({
  component: AppShell,
});

function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white/60 px-4 py-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/60">
        <p className="font-mono text-xs uppercase tracking-widest text-neutral-500">data-agent</p>
        <p className="text-xs text-neutral-500">authed shell — auth lands in 5d7e7d</p>
      </header>
      <main className="flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
