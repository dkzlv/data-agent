import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome.</h1>
      <p className="text-neutral-600 dark:text-neutral-400">
        Chat list, db profiles, and the chat UI land in subtasks fa583c, b75305, b1f5fd.
      </p>
    </div>
  );
}
