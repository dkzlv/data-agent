/**
 * WorkspaceSidebar — lists the artifacts the agent has produced in this
 * chat (most recent first), with a click-to-preview interaction.
 *
 * Backed by `GET /api/chats/:id/artifacts`. Polled at low frequency
 * (every 8s) while the chat page is mounted so newly produced artifacts
 * appear without a page reload — long-term we'll push these via the WS
 * channel, but polling is fine until volume warrants it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArtifactViewer, resolveArtifactUrl, type ArtifactRef } from "./ArtifactViewer";
import { chatsApi } from "~/lib/api";

interface WorkspaceSidebarProps {
  chatId: string;
}

export function WorkspaceSidebar({ chatId }: WorkspaceSidebarProps) {
  const list = useQuery({
    queryKey: ["chat-artifacts", chatId],
    queryFn: () => chatsApi.listArtifacts(chatId),
    refetchInterval: 8_000,
    refetchIntervalInBackground: false,
  });
  const [selected, setSelected] = useState<ArtifactRef | null>(null);

  const artifacts = list.data?.artifacts ?? [];

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-950/50">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Workspace
        </h2>
        <span className="text-[10px] text-neutral-400">
          {artifacts.length} item{artifacts.length === 1 ? "" : "s"}
        </span>
      </header>

      {list.isLoading && <div className="px-3 py-4 text-xs text-neutral-500">Loading…</div>}
      {list.error && (
        <div className="px-3 py-4 text-xs text-red-600 dark:text-red-400">
          {(list.error as Error).message}
        </div>
      )}

      {!list.isLoading && artifacts.length === 0 ? (
        <div className="space-y-1 px-3 py-4 text-xs text-neutral-500">
          <p>No artifacts yet.</p>
          <p>Charts and reports the agent produces will appear here.</p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() =>
                  setSelected({
                    ...(a as ArtifactRef),
                    // Resolve relative `/api/...` URLs against the
                    // api-gateway origin; otherwise the browser
                    // resolves them against the web worker and 404s.
                    url: resolveArtifactUrl(a.url),
                  })
                }
                className={[
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                  selected?.id === a.id
                    ? "bg-neutral-200/70 dark:bg-neutral-800"
                    : "hover:bg-neutral-200/40 dark:hover:bg-neutral-900",
                ].join(" ")}
                title={a.name}
              >
                <KindGlyph kind={a.kind} chartType={a.chartType} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="text-[10px] text-neutral-500">{formatRelative(a.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && <Preview artifact={selected} onClose={() => setSelected(null)} />}
    </aside>
  );
}

function KindGlyph({ kind, chartType }: { kind: string; chartType?: string }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-neutral-500";
  if (kind === "chart") {
    if (chartType === "line") {
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          <path
            d="M2 13L5 9 9 11 14 4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    if (chartType === "scatter") {
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          <circle cx="4" cy="11" r="1.2" fill="currentColor" />
          <circle cx="8" cy="6" r="1.2" fill="currentColor" />
          <circle cx="12" cy="9" r="1.2" fill="currentColor" />
          <circle cx="6" cy="3" r="1.2" fill="currentColor" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 16 16" className={cls} aria-hidden>
        <path
          d="M2 13V3M2 13h12"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M5 11V8M8 11V5M11 11V7"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={cls} aria-hidden>
      <path
        d="M3 1.5h7l3 3v10h-10z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d="M10 1.5v3.5h3"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Preview({ artifact, onClose }: { artifact: ArtifactRef; onClose: () => void }) {
  return (
    <div className="border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium" title={artifact.name}>
          {artifact.name}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>
      <ArtifactViewer ref={artifact} />
    </div>
  );
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
