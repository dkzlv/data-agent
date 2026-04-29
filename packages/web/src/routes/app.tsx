import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Menu, MessageSquare, Database, LogOut } from "lucide-react";
import { useState } from "react";
import { authClient } from "~/lib/auth-client";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "~/components/ui/sheet";
import { ThemeToggle } from "~/components/theme-toggle";

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const session = await authClient.getSession();
    if (!session.data?.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: AppShell,
});

const navLinkBase =
  "text-sm text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground [&.active]:font-medium";

const mobileNavLinkBase =
  "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:text-foreground";

function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  async function handleSignOut() {
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/* Mobile menu trigger — only visible below md. */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b border-border p-4">
              <SheetTitle className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                data-agent
              </SheetTitle>
            </SheetHeader>
            <nav className="flex flex-col gap-1 p-2">
              <Link
                to="/app"
                activeOptions={{ exact: true }}
                onClick={() => setMobileOpen(false)}
                className={mobileNavLinkBase}
              >
                <MessageSquare className="h-4 w-4" />
                Chats
              </Link>
              <Link
                to="/app/db-profiles"
                onClick={() => setMobileOpen(false)}
                className={mobileNavLinkBase}
              >
                <Database className="h-4 w-4" />
                Connections
              </Link>
              <button
                type="button"
                onClick={handleSignOut}
                className={`${mobileNavLinkBase} mt-2 cursor-pointer text-left`}
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </nav>
          </SheetContent>
        </Sheet>

        {/* Brand + nav (desktop) */}
        <Link
          to="/app"
          className="font-mono text-xs uppercase tracking-widest text-muted-foreground"
        >
          data-agent
        </Link>
        <nav className="hidden gap-5 md:flex md:ml-4">
          <Link to="/app" activeOptions={{ exact: true }} className={navLinkBase}>
            Chats
          </Link>
          <Link to="/app/db-profiles" className={navLinkBase}>
            Connections
          </Link>
        </nav>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className="hidden md:inline-flex"
          >
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
