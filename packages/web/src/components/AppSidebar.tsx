/**
 * AppSidebar — left navigation panel shared by every /app/* route.
 *
 * Replaces the old top-bar header. Houses:
 *   - Brand mark (link to /app)
 *   - Primary nav (Chats / Connections)
 *   - Inline chat list with a "New chat" launcher (shadcn DropdownMenu
 *     when there are 2+ DBs, single-click button otherwise)
 *   - Footer: theme toggle + sign out
 *
 * Used in two contexts:
 *   - Desktop (md+): permanent column rendered by AppShell.
 *   - Mobile: rendered inside a Sheet, triggered from a hamburger
 *     button that lives in the per-route top bar (chat title row,
 *     page header, etc).
 *
 * The component owns no router state — it accepts `onNavigate` so the
 * mobile Sheet host can close itself when a link is clicked. Keeping
 * this orthogonal means the same body works in both surfaces.
 */
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Database, LogOut, MessageSquare, Plus, Sparkles } from "lucide-react";
import { authClient } from "~/lib/auth-client";
import { chatsApi, dbProfilesApi, type Chat } from "~/lib/api";
import { isSampleProfile } from "~/lib/sample-db";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "~/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ThemeToggle } from "~/components/theme-toggle";
import { cn } from "~/lib/utils";

interface AppSidebarProps {
  /** Fired when a nav action runs — used by the mobile Sheet to close itself. */
  onNavigate?: () => void;
}

export function AppSidebar({ onNavigate }: AppSidebarProps) {
  async function handleSignOut() {
    onNavigate?.();
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand row — same height (h-14) the per-route mobile top bar uses
          so the sidebar's top edge aligns with main-column chrome. */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
        <Link
          to="/app"
          onClick={onNavigate}
          className="font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          data-agent
        </Link>
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col gap-0.5 px-2 py-2">
        <NavLink to="/app" icon={MessageSquare} onNavigate={onNavigate} exact>
          Chats
        </NavLink>
        <NavLink to="/app/db-profiles" icon={Database} onNavigate={onNavigate}>
          Connections
        </NavLink>
      </nav>

      {/* Chats list section — header + new-chat launcher + scrollable list. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent
          </span>
          <NewChatLauncher onNavigate={onNavigate} />
        </div>
        <SidebarChatList onNavigate={onNavigate} />
      </div>

      {/* Footer cluster — pinned to the bottom regardless of list length. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-sidebar-border px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="gap-2 text-muted-foreground hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );
}

function NavLink({
  to,
  icon: Icon,
  exact = false,
  onNavigate,
  children,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
  onNavigate?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      activeOptions={exact ? { exact: true } : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors",
        "hover:bg-sidebar-accent hover:text-foreground",
        "[&.active]:bg-sidebar-accent [&.active]:text-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{children}</span>
    </Link>
  );
}

/**
 * Inline chat list. Highlights the active chat (matches the URL via
 * useRouterState — TanStack's `[&.active]` only handles exact `to`,
 * but the sidebar's chat rows all point at `/app/chats/$chatId` so a
 * substring match is safe).
 *
 * Empty state is intentionally muted — the New chat affordance is in
 * the section header above, so we don't repeat it here.
 */
function SidebarChatList({ onNavigate }: { onNavigate?: () => void }) {
  const chats = useQuery({
    queryKey: ["chats"],
    queryFn: () => chatsApi.list().then((r) => r.chats),
  });
  const router = useRouterState({ select: (s) => s.location.pathname });

  return (
    <ScrollAreaRoot className="min-h-0 flex-1">
      <ScrollAreaViewport className="px-1.5 pb-2">
        {chats.isLoading && <ChatListSkeleton />}
        {chats.error && (
          <Alert variant="destructive" className="mx-1">
            <AlertDescription className="text-xs">
              {(chats.error as Error).message}
            </AlertDescription>
          </Alert>
        )}
        {chats.data && chats.data.length === 0 && !chats.isLoading && (
          <p className="px-2 py-2 text-xs text-muted-foreground">No chats yet.</p>
        )}
        {chats.data && chats.data.length > 0 && (
          <ul className="space-y-0.5">
            {chats.data.map((c) => (
              <li key={c.id}>
                <ChatLinkRow
                  chat={c}
                  active={router === `/app/chats/${c.id}`}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollAreaViewport>
      <ScrollAreaScrollbar>
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
    </ScrollAreaRoot>
  );
}

function ChatLinkRow({
  chat,
  active,
  onNavigate,
}: {
  chat: Chat;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to="/app/chats/$chatId"
      params={{ chatId: chat.id }}
      onClick={onNavigate}
      className={cn(
        "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      )}
      title={chat.title}
    >
      <span className="block truncate">{chat.title}</span>
    </Link>
  );
}

function ChatListSkeleton() {
  return (
    <ul className="space-y-0.5 px-1" aria-busy="true" aria-label="Loading chats">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="px-2.5 py-1.5">
          <Skeleton className="h-3.5" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Compact "New chat" affordance for the sidebar header. Mirrors the
 * behavior of the bigger button on /app/welcome:
 *   - 0 connections → routes to /app/db-profiles
 *   - 1 connection  → one-click create
 *   - 2+            → DropdownMenu of databases
 */
function NewChatLauncher({ onNavigate }: { onNavigate?: () => void }) {
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
      onNavigate?.();
      navigate({ to: "/app/chats/$chatId", params: { chatId: chat.id } });
    },
  });

  const list = profiles.data ?? [];
  const isPending = create.isPending || profiles.isLoading;

  if (!profiles.isLoading && list.length === 0) {
    return (
      <Button asChild variant="ghost" size="icon-sm" aria-label="Add a connection">
        <Link to="/app/db-profiles" onClick={onNavigate}>
          <Plus className="h-4 w-4" />
        </Link>
      </Button>
    );
  }

  if (list.length === 1) {
    const only = list[0]!;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => create.mutate(only.id)}
        disabled={isPending}
        aria-label="New chat"
      >
        <Plus className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={isPending}
          aria-label="New chat"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          New chat with
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {list.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => create.mutate(p.id)} className="gap-2">
            {isSampleProfile(p) ? (
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
            ) : (
              <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {isSampleProfile(p) && (
              <Badge variant="muted" className="text-[10px] uppercase">
                Demo
              </Badge>
            )}
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
