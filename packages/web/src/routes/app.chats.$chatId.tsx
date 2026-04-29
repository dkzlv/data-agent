import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { chatsApi } from "~/lib/api";

export const Route = createFileRoute("/app/chats/$chatId")({
  component: ChatDetail,
});

function ChatDetail() {
  const { chatId } = Route.useParams();
  const chat = useQuery({
    queryKey: ["chat", chatId],
    queryFn: () => chatsApi.get(chatId),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <p className="text-xs">
        <Link
          to="/app"
          className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← All chats
        </Link>
      </p>
      {chat.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {chat.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{(chat.error as Error).message}</p>
      )}
      {chat.data && (
        <>
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{chat.data.chat.title}</h1>
            <p className="text-xs text-neutral-500">
              {chat.data.members.length} member{chat.data.members.length === 1 ? "" : "s"}
            </p>
          </header>
          <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Chat UI lands in subtask fa583c — composer + WebSocket connection + streaming messages +
            tool-call cards + artifact viewer.
          </div>
        </>
      )}
    </div>
  );
}
