import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChatRoom } from "~/components/ChatRoom";
import { chatsApi } from "~/lib/api";

export const Route = createFileRoute("/app/chats/$chatId")({
  component: ChatDetail,
});

function ChatDetail() {
  const { chatId } = Route.useParams();
  const chat = useQuery({
    queryKey: ["chat", chatId],
    queryFn: () => chatsApi.get(chatId),
    // Avoid refetching while the chat is open — the WS is the source of truth.
    staleTime: 60_000,
  });

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-3">
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
      {chat.data && <ChatRoom chatId={chatId} title={chat.data.chat.title} />}
    </div>
  );
}
