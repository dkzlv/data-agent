/**
 * AppShell — global frame for /app/*.
 *
 * Layout (post-facelift 27f072): permanent left sidebar on md+ that
 * carries brand, primary nav, an inline chats list, and the footer
 * actions (theme toggle + sign out). Mobile gets the same content via
 * a Sheet triggered from each route's own header — every route
 * renders an `<AppMobileNavTrigger/>` (sub-md only) inside its title
 * row, so the hamburger sits next to the page title rather than
 * floating in a generic top bar. Chat detail puts the trigger next to
 * the chat title; list routes put it next to the page heading.
 *
 * Each child route owns its own scrolling — we don't wrap the main
 * column in a single ScrollArea here because chat detail has its own
 * internal flex column with bounded message-list and composer
 * regions, which would conflict with an outer scroller. Non-chat
 * routes use `<AppPageScroll/>` to opt in to a scrollable main area.
 */
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { AppSidebar } from "~/components/AppSidebar";

/**
 * Cache the session result for the lifetime of the page so we don't
 * re-hit `/api/auth/get-session` on every intra-app navigation. The
 * earlier setup ran the network round-trip from `beforeLoad` for every
 * /app/* nav — most visibly when going from /app to /app/chats/$id,
 * where TanStack Router unmounts the previous match while waiting on
 * `beforeLoad` and the user sees a flash of white. The per-route auth
 * check still happens on the *first* visit (so directly hitting
 * /app/chats/<id> in a fresh tab still bounces unauthenticated users
 * to /login), and the api-gateway is the authoritative gate — every
 * data fetch re-validates the cookie server-side.
 */
let sessionGate: Promise<boolean> | null = null;
function ensureSession(): Promise<boolean> {
  if (sessionGate) return sessionGate;
  sessionGate = authClient
    .getSession()
    .then((s) => Boolean(s.data?.user))
    .catch(() => false);
  return sessionGate;
}

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const ok = await ensureSession();
    if (!ok) {
      // Reset the cached promise so a subsequent re-auth path can try again.
      sessionGate = null;
      throw redirect({ to: "/login" });
    }
  },
  component: AppShell,
});

function AppShell() {
  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
      {/* Desktop sidebar — permanent on md+. */}
      <aside className="hidden h-full w-64 shrink-0 border-r border-sidebar-border md:flex md:flex-col">
        <AppSidebar />
      </aside>

      {/* Main column. Routes own their own scroll container — non-chat
          routes wrap themselves in <AppPageScroll/>; chat detail uses
          its own bounded flex layout. */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * AppPageScroll — wraps page content (non-chat routes) in a vertical
 * scroll container so the main column scrolls independently of the
 * sidebar. Use as the top-level element of a route component.
 *
 * Native `overflow-y-auto` rather than the Radix-style ScrollArea
 * because: (a) page content is page-sized markup that browsers scroll
 * very well natively, and (b) the only place we benefited from the
 * custom thumb was the chat history (kept) and the workspace list
 * (kept) — a third decorated scrollbar on the parent steals the eye.
 */
export function AppPageScroll({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">{children}</div>;
}

/**
 * AppMobileNavTrigger — hamburger that opens the AppSidebar in a
 * Sheet on sub-md. Each route renders its own instance inside its
 * title row so the trigger is co-located with the page heading. The
 * Sheet is stateless other than the shared React Query caches, so
 * mounting multiple instances across routes is fine (only one is
 * visible at a time).
 */
export function AppMobileNavTrigger() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open navigation" className="md:hidden">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation</SheetTitle>
        </SheetHeader>
        <AppSidebar onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
