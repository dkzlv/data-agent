import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { chatsApi, dbProfilesApi } from "~/lib/api";

export const Route = createFileRoute("/app/")({
  component: ChatsRoute,
});

function ChatsRoute() {
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        <NewChatButton />
      </header>

      {chats.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {chats.data?.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No chats yet. Create one to start asking questions.
        </div>
      )}

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {chats.data?.map((chat) => (
          <li key={chat.id}>
            <Link
              to="/app/chats/$chatId"
              params={{ chatId: chat.id }}
              className="flex items-center justify-between px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{chat.title}</p>
                <p className="text-xs text-neutral-500">
                  Updated {new Date(chat.updatedAt).toLocaleString()}
                </p>
              </div>
              <span className="text-neutral-400">→</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewChatButton() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dbProfileId, setDbProfileId] = useState<string>("");

  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      chatsApi.create({
        title: title.trim() || "Untitled chat",
        dbProfileId: dbProfileId || undefined,
      }),
    onSuccess: ({ chat }) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      setOpen(false);
      navigate({ to: "/app/chats/$chatId", params: { chatId: chat.id } });
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        New chat
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      className="flex items-center gap-2"
    >
      <input
        type="text"
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Chat title…"
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm focus:border-neutral-900 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950"
      />
      <select
        value={dbProfileId}
        onChange={(e) => setDbProfileId(e.target.value)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="">No database</option>
        {profiles.data?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        Create
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        Cancel
      </button>
    </form>
  );
}
