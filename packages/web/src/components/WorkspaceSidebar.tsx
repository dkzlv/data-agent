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
 * Visibility rules:
 *   - Desktop (md+): the permanent column **only mounts when the chat
 *     has at least one artifact**. Until then the chat column owns
 *     the full row width — there's no value in showing an empty
 *     "Workspace" sidebar that just teases future content. The
 *     artifact-count query lives in a small shared hook
 *     (`useArtifactCount`) so the chat header's mobile trigger and
 *     this component see the same number without double-fetching.
 *   - Mobile: the Sheet is opened on demand from the chat header's
 *     workspace button (see `WorkspaceMobileTrigger` in ChatRoom).
 *     The trigger renders a numeric badge whenever artifacts exist
 *     so the user sees the count without opening the sheet.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, FileText, LineChart, ScatterChart, X } from "lucide-react";
import { ArtifactViewer, resolveArtifactUrl, type ArtifactRef } from "./ArtifactViewer";
import { chatsApi, type ArtifactSummary } from "~/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface WorkspaceSidebarProps {
  chatId: string;
}

/**
 * Shared artifact-list query. Both the desktop sidebar and the mobile
 * trigger badge in ChatRoom call this with the same `chatId`, so React
 * Query dedupes the fetch. Centralising the polling cadence and the
 * `select` projection keeps both surfaces honest about the same data.
 */
export function useChatArtifacts(chatId: string) {
  return useQuery({
    queryKey: ["chat-artifacts", chatId],
    queryFn: () => chatsApi.listArtifacts(chatId),
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
    select: (r) => r.artifacts as ArtifactSummary[],
  });
}

export function WorkspaceSidebar({ chatId }: WorkspaceSidebarProps) {
  const list = useChatArtifacts(chatId);
  const count = list.data?.length ?? 0;

  // Don't render the desktop column until the chat has produced at
  // least one artifact. Mounting an empty workspace-with-empty-state
  // teased a feature the user hasn't engaged with yet, and stole
  // ~288px of horizontal width from the chat column for no reason.
  // Once an artifact exists the column appears (the chat content
  // re-flows accordingly — there's a one-time width shift, but it's
  // tied to a real signal: the agent just produced something).
  if (count === 0) return null;

  // Matches the AppShell main-column dimensions: workspace sits flush
  // against the right viewport edge with no parent padding/margin so
  // charts get the full sidebar width. Header is fixed at h-14 so its
  // bottom border lands on the same horizontal line as the chat
  // column's title row — without that, the two borders met at
  // slightly different heights and left a visible notch.
  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col border-l border-border bg-sidebar md:flex">
      <WorkspaceContent list={list} />
    </aside>
  );
}

/**
 * Body that's reused between the permanent desktop sidebar and the
 * mobile Sheet. Owns its own dialog state so the artifact preview
 * works the same in either context. The list query is hoisted to
 * the parent (so the desktop sidebar can decide whether to mount at
 * all, and the mobile trigger can read the count) and passed in.
 *
 * `inSheet` shifts the header so the artifact-count badge doesn't
 * sit underneath the Sheet's auto-injected close button (X) — the
 * Sheet pins that button at `top-4 right-4` and the count was
 * landing exactly there. We pad the header right so they don't
 * collide visually or steal each other's clicks.
 */
function WorkspaceContent({
  list,
  inSheet = false,
}: {
  list: ReturnType<typeof useChatArtifacts>;
  inSheet?: boolean;
}) {
  const [selected, setSelected] = useState<ArtifactRef | null>(null);
  const artifacts = list.data ?? [];

  return (
    <>
      <header
        className={cn(
          // h-14 mirrors the chat column's header so the two horizontal
          // borders line up exactly where the columns meet.
          "flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-3",
          // Reserve space for the Sheet's absolute-positioned close
          // button at top-right; without this the artifact count badge
          // sits underneath it on mobile.
          inSheet && "pr-10"
        )}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Workspace
        </h2>
        <Badge variant="muted" className="rounded-full px-1.5 py-0 text-[10px]">
          {artifacts.length}
        </Badge>
      </header>

      {list.error && (
        <div className="px-3 py-3 text-xs text-destructive">{(list.error as Error).message}</div>
      )}

      {/* Loading is treated identically to "no artifacts yet". The
          desktop sidebar only mounts when count > 0 (so it never
          actually shows this state), and the mobile sheet trigger is
          equally gated — meaning if a user gets here it's because the
          fetch raced into the body briefly. Showing the empty-state
          copy beats teasing fake skeleton rows for a feature that
          might not even apply to this chat. */}
      {!list.error && artifacts.length === 0 && (
        <div className="space-y-1 px-3 py-6 text-center text-xs text-muted-foreground">
          <p className="font-medium text-foreground/70">No artifacts yet</p>
          <p>Charts and reports the agent produces will appear here.</p>
        </div>
      )}

      {artifacts.length > 0 && (
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
 * same content as the desktop sidebar; the trigger button itself
 * advertises the artifact count via a badge (rendered by
 * `WorkspaceMobileTrigger` in ChatRoom).
 */
export function WorkspaceSidebarBody({ chatId }: WorkspaceSidebarProps) {
  const list = useChatArtifacts(chatId);
  return (
    <div className="flex h-full flex-col">
      <WorkspaceContent list={list} inSheet />
    </div>
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
