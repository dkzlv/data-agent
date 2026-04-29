import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChatRoom, Composer } from "~/components/ChatRoom";
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

  // Chat detail uses a full-height flex layout that fills the AppShell
  // main column edge-to-edge. The workspace sidebar inside ChatRoom
  // pins flush to the right of the viewport (no parent padding /
  // max-width) so the chat column gets the rest of the row. The
  // earlier `mx-auto max-w-6xl px-* py-*` wrapper centred everything
  // inside a 6xl box, which made the workspace look like it was
  // floating in negative space on wide screens.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {chat.isLoading && <ChatPageSkeleton />}

      {chat.error && (
        <div className="px-4 py-6 sm:px-6">
          <Alert variant="destructive">
            <AlertDescription>{(chat.error as Error).message}</AlertDescription>
          </Alert>
        </div>
      )}

      {chat.data && (
        <ChatRoom
          chatId={chatId}
          title={chat.data.chat.title}
          members={chat.data.members}
          isSampleDb={isSampleDb}
        />
      )}
    </div>
  );
}

function ChatPageSkeleton() {
  // Mirrors the resolved layout: full-height chat column (h-14 header +
  // full-bleed message list + composer footer). The workspace sidebar
  // is intentionally NOT skeletoned here — it only ever mounts when
  // the chat has at least one artifact (see `WorkspaceSidebar`), so
  // assuming "no artifacts" during initial load is the honest default.
  // The earlier route skeleton flashed a phantom workspace column with
  // 5 fake rows, which previewed a feature that often doesn't even
  // apply to the chat being opened.
  return (
    <div className="flex h-full min-h-0 flex-1" aria-busy="true" aria-label="Loading chat">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-4 sm:px-6">
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
        </div>
        {/* Render the *real* Composer (locked) instead of a sized
            Skeleton so the loading state is pixel-identical to the
            resolved chat. A naive `<Skeleton h-16/>` drifted from
            ~64px to ~115px once the InputGroup chrome hydrated and
            the layout visibly jumped on every nav into a chat. */}
        <div className="shrink-0 border-t border-border bg-background px-4 py-3 sm:px-6">
          <Composer
            locked
            isStreaming={false}
            onSubmit={() => {}}
            onStop={() => {}}
          />
        </div>
      </div>
    </div>
  );
}
