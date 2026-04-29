/**
 * ArtifactViewer — renders an artifact returned by `chart.*` or
 * `artifact.*` tool calls. Used inline in chat messages and inside
 * the workspace dialog (full-width).
 *
 * Behaviour by kind/mime:
 *
 *   - chart (vega-lite v5 spec)        → vega-embed render with theme follow
 *   - markdown                         → ReactMarkdown + GFM
 *   - csv / tsv                         → first 50 rows as a small table
 *   - json                              → pretty-printed JSON
 *   - any other text                    → <pre>
 *   - non-text                          → download link
 *
 * The viewer fetches lazily — the manifest only carries metadata, not
 * content. Authentication: the URL hits the api-gateway, which uses the
 * better-auth cookie to mint a chat token and forward to the DO.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import vegaEmbed from "vega-embed";
import { BarChart3, FileText, Table as TableIcon, ExternalLink } from "lucide-react";
import { Skeleton } from "~/components/ui/skeleton";
import { useTheme } from "~/components/theme-provider";
import { cn } from "~/lib/utils";

export interface ArtifactRef {
  id: string;
  name: string;
  mime: string;
  kind: "file" | "chart" | "table";
  url: string;
  createdAt: string;
  size: number;
  chartType?: string;
}

export function ArtifactViewer({
  ref: artifact,
  /**
   * When true, drop the framing card (border + size cap) — used in
   * the dialog where the chrome is owned by the dialog itself. The
   * default keeps the card so the inline-in-chat rendering still
   * has a visible boundary.
   */
  fullWidth = false,
}: {
  ref: ArtifactRef;
  fullWidth?: boolean;
}) {
  if (fullWidth) {
    // Dialog rendering: no surrounding card, no header — the dialog
    // chrome already supplies the title and close button.
    return <ArtifactBody artifact={artifact} fullWidth />;
  }
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card text-xs shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={artifact.kind} />
          <span className="truncate font-medium">{artifact.name}</span>
          <span className="text-[10px] text-muted-foreground">{formatBytes(artifact.size)}</span>
        </div>
        <a
          href={artifact.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          title="Open in a new tab"
        >
          open
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <ArtifactBody artifact={artifact} />
    </div>
  );
}

function KindIcon({ kind }: { kind: ArtifactRef["kind"] }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  if (kind === "chart") return <BarChart3 className={cls} aria-hidden />;
  if (kind === "table") return <TableIcon className={cls} aria-hidden />;
  return <FileText className={cls} aria-hidden />;
}

function ArtifactBody({
  artifact,
  fullWidth = false,
}: {
  artifact: ArtifactRef;
  fullWidth?: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(artifact.url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.url]);

  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-destructive">Failed to load artifact: {error}</div>
    );
  }
  if (content == null) {
    // Skeleton sized to roughly the kind's expected footprint so the
    // layout doesn't jump when the body resolves.
    return <ArtifactBodySkeleton kind={artifact.kind} fullWidth={fullWidth} />;
  }
  if (artifact.mime.includes("vegalite") || artifact.kind === "chart") {
    return <ChartBody specJson={content} fullWidth={fullWidth} />;
  }
  if (artifact.mime === "text/markdown") {
    return (
      <div
        className={cn("markdown-body break-words leading-relaxed", fullWidth ? "" : "px-3 py-2")}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (artifact.mime === "text/csv" || artifact.mime === "text/tab-separated-values") {
    return (
      <CsvBody
        content={content}
        delimiter={artifact.mime.includes("tab") ? "\t" : ","}
        fullWidth={fullWidth}
      />
    );
  }
  if (artifact.mime === "application/json") {
    return <JsonBody content={content} fullWidth={fullWidth} />;
  }
  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words bg-muted/40 text-[11px]",
        fullWidth ? "" : "max-h-72 px-3 py-2"
      )}
    >
      {content}
    </pre>
  );
}

function ArtifactBodySkeleton({
  kind,
  fullWidth,
}: {
  kind: ArtifactRef["kind"];
  fullWidth: boolean;
}) {
  if (kind === "chart") {
    return (
      <div className={cn("space-y-2", fullWidth ? "p-2" : "p-3")}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className={cn(fullWidth ? "h-72" : "h-48", "w-full")} />
      </div>
    );
  }
  if (kind === "table") {
    return (
      <div className={cn("space-y-1.5", fullWidth ? "p-2" : "px-3 py-2")}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className={cn("space-y-1.5", fullWidth ? "p-2" : "px-3 py-2")}>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function ChartBody({ specJson, fullWidth = false }: { specJson: string; fullWidth?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { resolved } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    let view: { finalize: () => void } | null = null;
    let cancelled = false;
    try {
      const spec = JSON.parse(specJson) as Record<string, unknown>;
      // When the chart is rendered full-width (dialog), drop the
      // explicit `width` from the spec so vega-embed expands to the
      // container. If the LLM hard-codes width=300 in a sidebar-
      // sized chart and we then show it in the dialog, the chart
      // would otherwise stay narrow with a sea of empty space.
      const renderSpec = fullWidth ? { ...spec, width: "container" } : spec;
      vegaEmbed(ref.current, renderSpec, {
        actions: { export: true, source: false, compiled: false, editor: false },
        renderer: "canvas",
        config: vegaThemeConfig(resolved === "dark"),
      })
        .then((res) => {
          if (cancelled) {
            res.finalize();
          } else {
            view = res;
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError((e as Error).message);
        });
    } catch (e) {
      setError((e as Error).message);
    }
    return () => {
      cancelled = true;
      view?.finalize();
    };
    // resolved is included so the chart re-renders on theme switch.
  }, [specJson, resolved, fullWidth]);

  return (
    <div className={cn(fullWidth ? "py-2" : "px-3 py-3")}>
      {error && <p className="text-[11px] text-destructive">Render error: {error}</p>}
      <div ref={ref} className="w-full overflow-x-auto" />
    </div>
  );
}

function vegaThemeConfig(dark: boolean): Record<string, unknown> {
  if (!dark) return {};
  // Minimal dark theme — matches the chat bubble background.
  return {
    background: null,
    view: { stroke: "transparent" },
    axis: {
      domainColor: "#444",
      gridColor: "#2a2a2a",
      tickColor: "#444",
      labelColor: "#cdcdcd",
      titleColor: "#e6e6e6",
    },
    legend: {
      labelColor: "#cdcdcd",
      titleColor: "#e6e6e6",
    },
    title: { color: "#e6e6e6" },
  };
}

function CsvBody({
  content,
  delimiter,
  fullWidth = false,
}: {
  content: string;
  delimiter: string;
  fullWidth?: boolean;
}) {
  // Tiny CSV split — no quote-handling for embedded delimiters. Good
  // enough for preview; if the LLM emits weird CSV we just degrade to
  // raw text via the catch-all below.
  const rows = content.split(/\r?\n/).slice(0, 51);
  const hasContent = rows.some((r) => r.length > 0);
  if (!hasContent) {
    return <div className="px-3 py-2 text-muted-foreground">empty CSV</div>;
  }
  const parsed = rows.map((r) => r.split(delimiter));
  const [header, ...body] = parsed;
  return (
    <div className={cn("overflow-auto", fullWidth ? "max-h-[70vh]" : "max-h-96 px-3 py-2")}>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {(header ?? []).map((h, i) => (
              <th
                key={i}
                className="sticky top-0 border-b border-border bg-muted/60 px-2 py-1 text-left font-medium"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 50).map((row, i) => (
            <tr key={i} className="even:bg-muted/30">
              {row.map((cell, j) => (
                <td key={j} className="border-b border-border px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > 50 && (
        <p className="mt-1 text-[10px] text-muted-foreground">+ {body.length - 50} more rows</p>
      )}
    </div>
  );
}

function JsonBody({ content, fullWidth = false }: { content: string; fullWidth?: boolean }) {
  let formatted = content;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // leave as-is
  }
  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words bg-muted/40 text-[11px]",
        fullWidth ? "max-h-[70vh] p-3" : "max-h-72 px-3 py-2"
      )}
    >
      {formatted}
    </pre>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Try to extract an ArtifactRef from arbitrary tool output. Direct
 * artifact returns and codemode-wrapped outputs (`{ code, result: <ref> }`)
 * are both handled. The output may also arrive as a JSON string instead
 * of a parsed object — we cope with that too.
 */
export function asArtifactRef(value: unknown): ArtifactRef | null {
  if (value == null) return null;
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null) return null;

  // Direct ref OR codemode wrapper. Try `value.result` first (codemode
  // shape), then fall back to the value itself.
  const direct = pickArtifactFields(v as Record<string, unknown>);
  if (direct) return direct;
  const wrapped = (v as { result?: unknown }).result;
  if (wrapped && typeof wrapped === "object") {
    return pickArtifactFields(wrapped as Record<string, unknown>);
  }
  return null;
}

function pickArtifactFields(v: Record<string, unknown>): ArtifactRef | null {
  if (
    typeof v.id === "string" &&
    typeof v.url === "string" &&
    typeof v.name === "string" &&
    typeof v.mime === "string" &&
    typeof v.kind === "string" &&
    (v.kind === "chart" || v.kind === "file" || v.kind === "table")
  ) {
    return {
      id: v.id,
      url: resolveArtifactUrl(v.url),
      name: v.name,
      mime: v.mime,
      kind: v.kind,
      createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
      size: typeof v.size === "number" ? v.size : 0,
      chartType: typeof v.chartType === "string" ? v.chartType : undefined,
    };
  }
  return null;
}

/**
 * Artifact URLs land here as `/api/chats/<id>/artifacts/<id>` — a
 * relative path that, in the browser, resolves against the web
 * origin (`data-agent.dkzlv.com`) rather than the api-gateway. The
 * web worker doesn't host that route, so the fetch 404s. Resolve
 * against `window.__ENV__.API_URL` when running in the browser; pass
 * through unchanged for SSR / non-relative URLs.
 *
 * Exported for reuse from `WorkspaceSidebar` (which builds an
 * ArtifactRef directly from the manifest list response).
 */
export function resolveArtifactUrl(url: string): string {
  if (!url.startsWith("/")) return url;
  if (typeof window === "undefined") return url;
  const apiUrl = (window as unknown as { __ENV__?: { API_URL?: string } }).__ENV__?.API_URL;
  if (!apiUrl) return url;
  return `${apiUrl.replace(/\/$/, "")}${url}`;
}
