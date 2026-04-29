import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ChevronRight, Plus, Database } from "lucide-react";
import { chatsApi, dbProfilesApi } from "~/lib/api";
import { isSampleProfile } from "~/lib/sample-db";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { ListSkeleton } from "~/components/list-skeleton";

export const Route = createFileRoute("/app/")({
  component: ChatsRoute,
});

function ChatsRoute() {
  const navigate = useNavigate();
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });

  // First-run redirect: a brand-new user (zero chats) lands on
  // `/app/welcome` with the demo CTA. We do this in an effect rather
  // than a TanStack `loader` redirect to avoid blocking the first
  // paint of the chats list for the common case (returning users).
  // The brief flash of the empty list is acceptable; if it ever
  // becomes visibly bad, migrate to a loader-based redirect.
  useEffect(() => {
    if (chats.data && chats.data.length === 0 && !chats.isLoading && !chats.error) {
      navigate({ to: "/app/welcome", replace: true });
    }
  }, [chats.data, chats.isLoading, chats.error, navigate]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Chats</h1>
        <NewChatDialog />
      </header>

      {chats.isLoading && <ListSkeleton rows={4} />}

      {chats.error && (
        <Alert variant="destructive">
          <AlertDescription>{(chats.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {chats.data && chats.data.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No chats yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one to start asking questions about your data.
          </p>
        </div>
      )}

      {chats.data && chats.data.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {chats.data.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/app/chats/$chatId"
                params={{ chatId: chat.id }}
                className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{chat.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Updated {new Date(chat.updatedAt).toLocaleString()}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "New chat" entry point.
 *
 * Behaviour by connection count:
 *   - 0 connections → button routes the user to `/app/db-profiles`
 *     so they can add one before creating a chat.
 *   - 1 connection  → button creates a chat against it immediately
 *     (no menu, no extra click — the only choice is obvious).
 *   - 2+ connections → button opens a DropdownMenu listing the
 *     connections; clicking one creates the chat.
 *
 * Earlier this was a Dialog with a database <Select> and a
 * `Create` submit button — three clicks for the common single-DB
 * case. The dropdown collapses that to one click for the mid-case
 * and zero extra clicks for the single-DB case. Auto-titling means
 * we no longer need a `title` field at create time.
 */
function NewChatDialog() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const profiles = useQuery({
    queryKey: ["db-profiles"],
    queryFn: () => dbProfilesApi.list().then((r) => r.profiles),
  });

  const create = useMutation({
    mutationFn: (dbProfileId: string | undefined) => chatsApi.create({ dbProfileId }),
    onSuccess: ({ chat }) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      navigate({ to: "/app/chats/$chatId", params: { chatId: chat.id } });
    },
  });

  const isPending = create.isPending || profiles.isLoading;
  const list = profiles.data ?? [];

  // Zero connections → guide the user to add one.
  if (!profiles.isLoading && list.length === 0) {
    return (
      <Button size="sm" asChild>
        <Link to="/app/db-profiles">
          <Plus className="h-4 w-4" />
          New chat
        </Link>
      </Button>
    );
  }

  // Single connection → one-click create. Don't bother showing a menu
  // when there's only ever one possible choice.
  if (list.length === 1) {
    const only = list[0]!;
    return (
      <Button size="sm" disabled={isPending} onClick={() => create.mutate(only.id)}>
        <Plus className="h-4 w-4" />
        {create.isPending ? "Creating…" : "New chat"}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={isPending}>
            <Plus className="h-4 w-4" />
            New chat
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Pick a database
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {list.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => create.mutate(p.id)}
              className="gap-2"
            >
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {isSampleProfile(p) && (
                <Badge variant="muted" className="text-[10px] uppercase">
                  Demo
                </Badge>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {create.error && (
        <Alert variant="destructive">
          <AlertDescription>{(create.error as Error).message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
