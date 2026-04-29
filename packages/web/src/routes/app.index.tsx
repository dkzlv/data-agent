/**
 * /app — the chats landing page.
 *
 * Post-facelift (27f072) the chat list lives in the left sidebar, so
 * this page is no longer the directory of chats. We keep it as the
 * "no chat selected" landing — first-run users still get bounced to
 * /app/welcome, returning users see a quiet placeholder that points
 * back at the sidebar list.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { chatsApi } from "~/lib/api";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { AppMobileNavTrigger, AppPageScroll } from "~/routes/app";

export const Route = createFileRoute("/app/")({
  component: ChatsRoute,
});

function ChatsRoute() {
  const navigate = useNavigate();
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });

  // First-run redirect: brand-new users (zero chats) land on
  // `/app/welcome`. We do this in an effect rather than a TanStack
  // `loader` redirect so the sidebar-cached chat list query (already
  // resolved for returning users) doesn't gate first paint.
  useEffect(() => {
    if (chats.data && chats.data.length === 0 && !chats.isLoading && !chats.error) {
      navigate({ to: "/app/welcome", replace: true });
    }
  }, [chats.data, chats.isLoading, chats.error, navigate]);

  return (
    <AppPageScroll>
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header className="flex items-center gap-2">
          <AppMobileNavTrigger />
          <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        </header>

        {chats.error && (
          <Alert variant="destructive">
            <AlertDescription>{(chats.error as Error).message}</AlertDescription>
          </Alert>
        )}

        {chats.data && chats.data.length > 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
            <MessageSquare className="mx-auto mb-2 h-5 w-5 text-muted-foreground/70" />
            <p className="font-medium text-foreground">Pick a chat from the sidebar</p>
            <p className="mt-1">
              Or start a new one with the <span className="font-mono">+</span> button.
            </p>
          </div>
        )}
      </div>
    </AppPageScroll>
  );
}
