/**
 * WorkspaceSidebar — lists the artifacts the agent has produced in this
 * chat (most recent first), with click-to-open full-size preview in a
 * shadcn Dialog. Earlier versions rendered a mini ArtifactViewer
 * inline in the sidebar; that double-displayed the artifact (already
 * inline in the chat) and clipped chart titles inside the 288px-wide
 * column. Dialog gives the chart full breathing room.
 *
 * Backed by `GET /api/chats/:id/artifacts`. Polled at low frequency
 * (every 8s) while the chat page is mounted so newly produced artifacts
 * appear without a page reload — long-term we'll push these via the WS
 * channel, but polling is fine until volume warrants it.
 *
 * Two layouts:
 *   - Desktop (md+): permanent column on the right of the chat.
 *   - Mobile: rendered inside a Sheet via <WorkspaceSidebarSheet>.
 *     The same body is shared; only the chrome differs.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, FileText, LineChart, ScatterChart, X } from "lucide-react";
import { ArtifactViewer, resolveArtifactUrl, type ArtifactRef } from "./ArtifactViewer";
import { chatsApi } from "~/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface WorkspaceSidebarProps {
  chatId: string;
}

export function WorkspaceSidebar({ chatId }: WorkspaceSidebarProps) {
  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-border bg-sidebar md:flex">
      <WorkspaceContent chatId={chatId} />
    </aside>
  );
}

/**
 * Body that's reused between the permanent desktop sidebar and the
 * mobile Sheet. Owns its own dialog state so the artifact preview
 * works the same in either context.
 *
 * `inSheet` shifts the header so the artifact-count badge doesn't
 * sit underneath the Sheet's auto-injected close button (X) — the
 * Sheet pins that button at `top-4 right-4` and the count was
 * landing exactly there. We pad the header right so they don't
 * collide visually or steal each other's clicks.
 */
function WorkspaceContent({ chatId, inSheet = false }: { chatId: string; inSheet?: boolean }) {
  const list = useQuery({
    queryKey: ["chat-artifacts", chatId],
    queryFn: () => chatsApi.listArtifacts(chatId),
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
  });
  const [selected, setSelected] = useState<ArtifactRef | null>(null);

  const artifacts = list.data?.artifacts ?? [];

  return (
    <>
      <header
        className={cn(
          "flex items-center justify-between border-b border-sidebar-border px-3 py-2.5",
          // Reserve space for the Sheet's absolute-positioned close
          // button at top-right; without this the artifact count badge
          // sits underneath it on mobile.
          inSheet && "pr-10"
        )}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Workspace
        </h2>
        {!list.isLoading && (
          <Badge variant="muted" className="rounded-full px-1.5 py-0 text-[10px]">
            {artifacts.length}
          </Badge>
        )}
      </header>

      {list.isLoading && <SidebarSkeletons />}

      {list.error && (
        <div className="px-3 py-3 text-xs text-destructive">{(list.error as Error).message}</div>
      )}

      {!list.isLoading && !list.error && artifacts.length === 0 && (
        <div className="space-y-1 px-3 py-6 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground/70">No artifacts yet</p>
          <p>Charts and reports the agent produces will appear here.</p>
        </div>
      )}

      {!list.isLoading && artifacts.length > 0 && (
        <ScrollArea className="flex-1">
          <ul className="py-1">
            {artifacts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSelected({
                      ...(a as ArtifactRef),
                      url: resolveArtifactUrl(a.url),
                    })
                  }
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-sidebar-accent"
                  title={a.name}
                >
                  <KindGlyph kind={a.kind} chartType={a.chartType} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {formatRelative(a.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}

      <ArtifactDialog artifact={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/**
 * Mobile-only entry point: pass this through to the chat header so the
 * user can pop the workspace open from a button. The drawer mounts the
 * same content as the desktop sidebar.
 */
export function WorkspaceSidebarBody({ chatId }: WorkspaceSidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <WorkspaceContent chatId={chatId} inSheet />
    </div>
  );
}

function SidebarSkeletons() {
  // Five rows of compact tile skeletons matching the real artifact
  // tile height (32px-ish row with a 14px glyph + 14px text). Keeping
  // the exact dimensions means the layout doesn't shift when data
  // resolves.
  return (
    <ul className="py-1" aria-busy="true" aria-label="Loading artifacts">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-2 px-3 py-2">
          <Skeleton className="h-3.5 w-3.5 rounded-sm" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${65 + ((i * 11) % 25)}%` }} />
          <Skeleton className="h-3 w-6" />
        </li>
      ))}
    </ul>
  );
}

function ArtifactDialog({
  artifact,
  onClose,
}: {
  artifact: ArtifactRef | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!artifact} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        hideCloseButton
        className={cn(
          "w-[min(92vw,900px)] max-w-[min(92vw,900px)] gap-0 overflow-hidden p-0",
          "max-h-[90vh]"
        )}
      >
        <DialogHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-3 space-y-0">
          <DialogTitle className="truncate text-sm font-medium">
            {artifact?.name ?? "Artifact"}
          </DialogTitle>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <div className="max-h-[calc(90vh-3.5rem)] overflow-auto p-5">
          {artifact && <ArtifactViewer ref={artifact} fullWidth />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KindGlyph({ kind, chartType }: { kind: string; chartType?: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  if (kind === "chart") {
    if (chartType === "line") return <LineChart className={cls} aria-hidden />;
    if (chartType === "scatter") return <ScatterChart className={cls} aria-hidden />;
    return <BarChart3 className={cls} aria-hidden />;
  }
  return <FileText className={cls} aria-hidden />;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
