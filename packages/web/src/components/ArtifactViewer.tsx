/**
 * ArtifactViewer — renders an artifact returned by `chart.*` or
 * `artifact.*` tool calls. Inline in the chat message stream.
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

export function ArtifactViewer({ ref: artifact }: { ref: ArtifactRef }) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-neutral-300 bg-white text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <div className="flex min-w-0 items-center gap-2">
          <KindIcon kind={artifact.kind} />
          <span className="truncate font-medium">{artifact.name}</span>
          <span className="text-[10px] text-neutral-500">{formatBytes(artifact.size)}</span>
        </div>
        <a
          href={artifact.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
          title="Open in a new tab"
        >
          open
        </a>
      </div>
      <ArtifactBody artifact={artifact} />
    </div>
  );
}

function KindIcon({ kind }: { kind: ArtifactRef["kind"] }) {
  // Tiny inline SVG monograms — no dep on an icon library, no extra request.
  const common = "h-3.5 w-3.5 shrink-0 text-neutral-500";
  if (kind === "chart") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden>
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
  if (kind === "table") {
    return (
      <svg viewBox="0 0 16 16" className={common} aria-hidden>
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          stroke="currentColor"
          strokeWidth="1.2"
          fill="none"
        />
        <path d="M2.5 6h11M6 2.5v11" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={common} aria-hidden>
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

function ArtifactBody({ artifact }: { artifact: ArtifactRef }) {
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
      <div className="px-3 py-2 text-red-600 dark:text-red-400">
        Failed to load artifact: {error}
      </div>
    );
  }
  if (content == null) {
    return <div className="px-3 py-2 text-neutral-500">Loading…</div>;
  }
  if (artifact.mime.includes("vegalite") || artifact.kind === "chart") {
    return <ChartBody specJson={content} />;
  }
  if (artifact.mime === "text/markdown") {
    return (
      <div className="markdown-body break-words px-3 py-2 leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }
  if (artifact.mime === "text/csv" || artifact.mime === "text/tab-separated-values") {
    return <CsvBody content={content} delimiter={artifact.mime.includes("tab") ? "\t" : ","} />;
  }
  if (artifact.mime === "application/json") {
    return <JsonBody content={content} />;
  }
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-neutral-50 px-3 py-2 text-[11px] dark:bg-neutral-950">
      {content}
    </pre>
  );
}

function ChartBody({ specJson }: { specJson: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    let view: { finalize: () => void } | null = null;
    let cancelled = false;
    try {
      const spec = JSON.parse(specJson);
      vegaEmbed(ref.current, spec, {
        actions: { export: true, source: false, compiled: false, editor: false },
        renderer: "canvas",
        config: detectVegaTheme(),
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
  }, [specJson]);

  return (
    <div className="px-3 py-3">
      {error && <p className="text-[11px] text-red-600 dark:text-red-400">Render error: {error}</p>}
      <div ref={ref} className="w-full overflow-x-auto" />
    </div>
  );
}

function detectVegaTheme(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  if (!dark) return {};
  // Minimal dark theme — matches the chat bubble background.
  return {
    background: null,
    view: { stroke: "transparent" },
    style: {},
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

function CsvBody({ content, delimiter }: { content: string; delimiter: string }) {
  // Tiny CSV split — no quote-handling for embedded delimiters. Good
  // enough for preview; if the LLM emits weird CSV we just degrade to
  // raw text via the catch-all below.
  const rows = content.split(/\r?\n/).slice(0, 51);
  const hasContent = rows.some((r) => r.length > 0);
  if (!hasContent) {
    return <div className="px-3 py-2 text-neutral-500">empty CSV</div>;
  }
  const parsed = rows.map((r) => r.split(delimiter));
  const [header, ...body] = parsed;
  return (
    <div className="max-h-96 overflow-auto px-3 py-2">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {(header ?? []).map((h, i) => (
              <th
                key={i}
                className="border-b border-neutral-300 bg-neutral-50 px-2 py-1 text-left font-medium dark:border-neutral-700 dark:bg-neutral-900"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 50).map((row, i) => (
            <tr key={i} className="even:bg-neutral-50/50 dark:even:bg-neutral-900/40">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="border-b border-neutral-200 px-2 py-1 dark:border-neutral-800"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > 50 && (
        <p className="mt-1 text-[10px] text-neutral-500">+ {body.length - 50} more rows</p>
      )}
    </div>
  );
}

function JsonBody({ content }: { content: string }) {
  let formatted = content;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // leave as-is
  }
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-neutral-50 px-3 py-2 text-[11px] dark:bg-neutral-950">
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
 * Try to extract an ArtifactRef from arbitrary tool output. Tools shape
 * their output in our codebase, but the LLM may also send custom shapes
 * — we hunt for the canonical fields.
 */
export function asArtifactRef(value: unknown): ArtifactRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
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
      url: v.url,
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
