import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChatRoom } from "~/components/ChatRoom";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { chatsApi, dbProfilesApi } from "~/lib/api";
import { isSampleProfile } from "~/lib/sample-db";

export const Route = createFileRoute("/app/chats/$chatId")({
  component: ChatDetail,
  // Show the skeleton immediately on intent-preload / hydration so the
  // user never sees a white flash while the chat data resolves. The
  // earlier setup let the parent unmount before `useQuery` had even
  // started, which manifested as a brief blank page on every nav from
  // the chats list into a chat.
  pendingComponent: ChatPageSkeleton,
});

function ChatDetail() {
  const { chatId } = Route.useParams();
  const chat = useQuery({
    queryKey: ["chat", chatId],
    queryFn: () => chatsApi.get(chatId),
    // Avoid refetching while the chat is open — the WS is the source of truth.
    staleTime: 60_000,
  });

  // Profiles are cached across routes (same query key as the index +
  // welcome routes), so this is a free lookup for the demo-chip
  // gate. We can't drive isSampleDb off the chat fetch alone — only
  // the dbProfileId comes back, not the profile name.
  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
  });

  const profile = chat.data?.chat.dbProfileId
    ? profiles.data?.find((p) => p.id === chat.data!.chat.dbProfileId)
    : undefined;
  const isSampleDb = profile ? isSampleProfile(profile) : false;

  return (
    <div className="flex h-full flex-col gap-3">
      {chat.isLoading && <ChatPageSkeleton />}

      {chat.error && (
        <Alert variant="destructive">
          <AlertDescription>{(chat.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {chat.data && (
        <div className="mx-auto w-full max-w-6xl flex-1 overflow-hidden">
          <ChatRoom
            chatId={chatId}
            title={chat.data.chat.title}
            members={chat.data.members}
            isSampleDb={isSampleDb}
          />
        </div>
      )}
    </div>
  );
}

function ChatPageSkeleton() {
  // Mirrors the resolved layout: page header (title + actions row),
  // message list panel, composer. Heights match the real component
  // (h-[calc(100dvh-7rem)] container, ~68px header, flex-1 list,
  // composer ~5rem). Sized to match, so the layout doesn't pop when
  // the chat resolves.
  return (
    <div
      className="mx-auto flex h-[calc(100dvh-7rem)] w-full max-w-6xl flex-col gap-3"
      aria-busy="true"
      aria-label="Loading chat"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <Skeleton className="h-7 w-56" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <div className="flex flex-1 gap-0 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex-1 space-y-4 rounded-lg border border-border bg-card p-4">
            <div className="flex justify-end">
              <Skeleton className="h-9 w-2/3 rounded-2xl sm:w-1/2" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-16 w-3/4 rounded-2xl sm:w-2/3" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-12 w-1/2 rounded-2xl" />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Skeleton className="h-12 flex-1" />
            <Skeleton className="h-12 w-20" />
          </div>
        </div>
        <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-border bg-sidebar md:flex">
          <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-6 rounded-full" />
          </div>
          <ul className="py-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex items-center gap-2 px-3 py-2">
                <Skeleton className="h-3.5 w-3.5 rounded-sm" />
                <Skeleton
                  className="h-3.5 flex-1"
                  style={{ maxWidth: `${65 + ((i * 11) % 25)}%` }}
                />
                <Skeleton className="h-3 w-6" />
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
