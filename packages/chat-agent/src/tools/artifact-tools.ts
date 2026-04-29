/**
 * `artifact.*` and `chart.*` ToolProviders.
 *
 * Artifacts are durable named outputs the agent produces during a turn:
 * markdown summaries, CSV exports, JSON dumps, chart specs, etc. They
 * persist in the chat's R2-backed Workspace under `/artifacts/<id>`.
 *
 * The chat UI subscribes to "artifact created" events (via the
 * `cf_agent_message_updated` part stream) so the user sees them appear
 * as the agent works.
 *
 * Inside a codemode function:
 *
 *   const a = await artifact.save("report.md", markdownText, "text/markdown");
 *   const csv = await artifact.save("rows.csv", csvText, "text/csv");
 *
 *   const chart = await chart.bar({
 *     data: rows,                        // Array<{ category: ..., value: ... }>
 *     x: "category",
 *     y: "value",
 *     title: "Top 10 customers by revenue",
 *   });
 *
 * Both return `{ id, url, name, mime, kind }`. The URL points at
 *   /api/chats/<chatId>/artifacts/<id>
 * which is served from the ChatAgent's fetch() handler with strong
 * caching headers (artifacts are immutable once created).
 *
 * Chart specs use the Vega-Lite v5 schema. Subtask abe549 ships the
 * vega-lite types for the sandbox so the LLM can also assemble custom
 * specs via `chart.spec({ ... })`.
 */
import type { ToolProvider } from "@cloudflare/codemode";
import type { Workspace } from "@cloudflare/shell";

const MANIFEST_PATH = "/artifacts/_manifest.json";
const ARTIFACTS_DIR = "/artifacts";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per artifact

export type ArtifactKind = "file" | "chart" | "table";

export interface ArtifactRef {
  id: string;
  /** User-visible name. Sanitized for filesystem safety. */
  name: string;
  /** Best-effort MIME type. */
  mime: string;
  kind: ArtifactKind;
  /** Path served by the ChatAgent's HTTP handler. */
  url: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** Approximate size in bytes. */
  size: number;
  /** For charts: the canonical chart "type" (e.g. "bar", "line"). */
  chartType?: string;
}

interface Manifest {
  artifacts: ArtifactRef[];
}

interface WorkspaceLike {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes?(path: string, content: Uint8Array): Promise<void>;
  exists?(path: string): Promise<boolean>;
  readdir?(path: string): Promise<string[]>;
  mkdir?(path: string): Promise<void>;
}

interface AgentLike {
  /** chat id — used in artifact URLs. */
  name: string;
  workspace: Workspace;
}

function sanitizeName(raw: string): string {
  // Allow letters, digits, ., _, -. Replace runs of anything else with `-`.
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "artifact";
}

function inferMime(name: string, fallback?: string): string {
  if (fallback) return fallback;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "tsv":
      return "text/tab-separated-values";
    case "json":
      return "application/json";
    case "txt":
      return "text/plain";
    case "html":
      return "text/html";
    case "vl.json":
    case "vegalite":
      return "application/vnd.vegalite.v5+json";
    default:
      return "text/plain";
  }
}

async function loadManifest(ws: WorkspaceLike): Promise<Manifest> {
  try {
    const json = await ws.readFile(MANIFEST_PATH);
    if (!json) return { artifacts: [] };
    const parsed = JSON.parse(json) as Manifest;
    return parsed.artifacts ? parsed : { artifacts: [] };
  } catch {
    return { artifacts: [] };
  }
}

async function saveManifest(ws: WorkspaceLike, m: Manifest): Promise<void> {
  await ws.writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

async function persistArtifact(
  agent: AgentLike,
  ref: Omit<ArtifactRef, "url">,
  body: string | Uint8Array
): Promise<ArtifactRef> {
  const ws = agent.workspace as unknown as WorkspaceLike;
  if (typeof body === "string") {
    if (body.length > MAX_BYTES) {
      throw new Error(`artifact too large (${body.length} bytes, max ${MAX_BYTES})`);
    }
    await ws.writeFile(`${ARTIFACTS_DIR}/${ref.id}`, body);
  } else {
    if (body.byteLength > MAX_BYTES) {
      throw new Error(`artifact too large (${body.byteLength} bytes, max ${MAX_BYTES})`);
    }
    if (!ws.writeFileBytes) {
      // Workspace from @cloudflare/shell exposes writeFileBytes; if it's
      // missing we encode as base64 — defensive, never expected to hit.
      const b64 = btoa(String.fromCharCode(...body));
      await ws.writeFile(`${ARTIFACTS_DIR}/${ref.id}.b64`, b64);
    } else {
      await ws.writeFileBytes(`${ARTIFACTS_DIR}/${ref.id}`, body);
    }
  }
  const manifest = await loadManifest(ws);
  const url = `/api/chats/${encodeURIComponent(agent.name)}/artifacts/${ref.id}`;
  const final: ArtifactRef = { ...ref, url };
  // Replace if same id (idempotent re-saves), otherwise prepend.
  manifest.artifacts = [final, ...manifest.artifacts.filter((a) => a.id !== ref.id)].slice(
    0,
    500 // hard cap on manifest length
  );
  await saveManifest(ws, manifest);
  return final;
}

export function artifactTools(agent: AgentLike): ToolProvider {
  const types = `
declare const artifact: {
  /** Persist a named artifact in the chat's workspace. Returns a stable
   *  reference with a URL the chat UI uses to render it. */
  save(
    name: string,
    content: string,
    mime?: string
  ): Promise<{
    id: string;
    name: string;
    mime: string;
    kind: "file" | "chart" | "table";
    url: string;
    createdAt: string;
    size: number;
  }>;

  /** Read an artifact's raw text content by id or by name (latest match). */
  read(idOrName: string): Promise<{ content: string; mime: string; ref: {
    id: string; name: string; mime: string; kind: "file" | "chart" | "table";
    url: string; createdAt: string; size: number;
  } }>;

  /** List all artifacts in this chat, newest first. */
  list(): Promise<Array<{
    id: string;
    name: string;
    mime: string;
    kind: "file" | "chart" | "table";
    url: string;
    createdAt: string;
    size: number;
  }>>;
};
`;

  const save = async (
    rawName: unknown,
    rawContent: unknown,
    rawMime: unknown
  ): Promise<ArtifactRef> => {
    if (typeof rawName !== "string" || !rawName) {
      throw new Error("artifact.save(name, content, mime?) — `name` required");
    }
    if (typeof rawContent !== "string") {
      throw new Error("artifact.save: `content` must be a string");
    }
    const name = sanitizeName(rawName);
    const mime = inferMime(name, typeof rawMime === "string" ? rawMime : undefined);
    const id = crypto.randomUUID();
    return persistArtifact(
      agent,
      {
        id,
        name,
        mime,
        kind: "file",
        size: rawContent.length,
        createdAt: new Date().toISOString(),
      },
      rawContent
    );
  };

  const list = async (): Promise<ArtifactRef[]> => {
    const m = await loadManifest(agent.workspace as unknown as WorkspaceLike);
    return m.artifacts;
  };

  const read = async (
    rawIdOrName: unknown
  ): Promise<{ content: string; mime: string; ref: ArtifactRef }> => {
    if (typeof rawIdOrName !== "string" || !rawIdOrName) {
      throw new Error("artifact.read(idOrName) — argument required");
    }
    const m = await loadManifest(agent.workspace as unknown as WorkspaceLike);
    const ref =
      m.artifacts.find((a) => a.id === rawIdOrName) ??
      m.artifacts.find((a) => a.name === rawIdOrName);
    if (!ref) throw new Error(`artifact "${rawIdOrName}" not found`);
    const content = await (agent.workspace as unknown as WorkspaceLike).readFile(
      `${ARTIFACTS_DIR}/${ref.id}`
    );
    if (content == null) {
      throw new Error(`artifact "${ref.name}" found in manifest but content is missing`);
    }
    return { content, mime: ref.mime, ref };
  };

  return {
    name: "artifact",
    types,
    positionalArgs: true,
    tools: {
      save: {
        description: "Persist a named output (markdown/csv/json/text) to the chat's workspace.",
        execute: async (...args: unknown[]) => save(args[0], args[1], args[2]),
      },
      read: {
        description: "Read an artifact's raw content by id or name.",
        execute: async (...args: unknown[]) => read(args[0]),
      },
      list: {
        description: "List all artifacts in this chat, newest first.",
        execute: async () => list(),
      },
    },
  };
}

// ─── chart.* ────────────────────────────────────────────────────────────────

interface BaseChartArgs {
  data: ReadonlyArray<Record<string, unknown>>;
  x: string;
  y: string;
  /** Optional series field for grouped bars / multi-line charts. */
  color?: string;
  /** Aggregation operator for `y` (default `sum` when there are duplicate `x`s, otherwise none). */
  aggregate?: "sum" | "mean" | "median" | "min" | "max" | "count";
  title?: string;
  /** Display name for the artifact (default derived from title). */
  name?: string;
}

interface SpecArgs {
  spec: Record<string, unknown>;
  title?: string;
  name?: string;
}

function vegaLiteBase(title: string | undefined): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    ...(title ? { title } : {}),
    width: "container",
    height: 320,
    autosize: { type: "fit", contains: "padding" },
  };
}

function inferType(data: ReadonlyArray<Record<string, unknown>>, field: string): string {
  for (const row of data) {
    const v = row[field];
    if (v == null) continue;
    if (typeof v === "number") return "quantitative";
    if (v instanceof Date) return "temporal";
    if (typeof v === "string") {
      // Loose ISO-8601 sniff — anything else is nominal
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "temporal";
      return "nominal";
    }
  }
  return "nominal";
}

function chartArtifactRef(
  agent: AgentLike,
  args: { title?: string; name?: string; chartType: string },
  spec: Record<string, unknown>
): Promise<ArtifactRef> {
  const id = crypto.randomUUID();
  const baseName = sanitizeName(args.name ?? args.title ?? `${args.chartType}-chart`);
  const name = baseName.endsWith(".vl.json") ? baseName : `${baseName}.vl.json`;
  const json = JSON.stringify(spec, null, 2);
  return persistArtifact(
    agent,
    {
      id,
      name,
      mime: "application/vnd.vegalite.v5+json",
      kind: "chart",
      size: json.length,
      createdAt: new Date().toISOString(),
      chartType: args.chartType,
    },
    json
  );
}

function buildSimpleSpec(
  args: BaseChartArgs,
  mark: "bar" | "line" | "point" | "area"
): Record<string, unknown> {
  const xType = inferType(args.data, args.x);
  const yType = "quantitative"; // y is always numeric for these charts
  const encoding: Record<string, unknown> = {
    x: { field: args.x, type: xType, title: args.x },
    y: {
      field: args.y,
      type: yType,
      title: args.y,
      ...(args.aggregate ? { aggregate: args.aggregate } : {}),
    },
  };
  if (args.color) {
    encoding.color = { field: args.color, type: inferType(args.data, args.color) };
  }
  return {
    ...vegaLiteBase(args.title),
    data: { values: args.data },
    mark: mark === "point" ? { type: "point", filled: true } : mark,
    encoding,
  };
}

function validateBaseArgs(raw: unknown): BaseChartArgs {
  const a = raw as Partial<BaseChartArgs>;
  if (!Array.isArray(a?.data)) throw new Error("chart: `data` must be an array of rows");
  if (typeof a.x !== "string") throw new Error("chart: `x` (field name) is required");
  if (typeof a.y !== "string") throw new Error("chart: `y` (field name) is required");
  return {
    data: a.data,
    x: a.x,
    y: a.y,
    color: typeof a.color === "string" ? a.color : undefined,
    aggregate: a.aggregate,
    title: typeof a.title === "string" ? a.title : undefined,
    name: typeof a.name === "string" ? a.name : undefined,
  };
}

export function chartTools(agent: AgentLike): ToolProvider {
  const types = `
declare const chart: {
  /** Bar chart. \`x\` is the categorical field, \`y\` is the value. */
  bar(args: {
    data: ReadonlyArray<Record<string, unknown>>;
    x: string;
    y: string;
    color?: string;
    aggregate?: "sum" | "mean" | "median" | "min" | "max" | "count";
    title?: string;
    name?: string;
  }): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: "bar";
  }>;

  /** Line chart. Use a temporal or ordinal \`x\`. */
  line(args: {
    data: ReadonlyArray<Record<string, unknown>>;
    x: string;
    y: string;
    color?: string;
    aggregate?: "sum" | "mean" | "median" | "min" | "max" | "count";
    title?: string;
    name?: string;
  }): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: "line";
  }>;

  /** Scatter plot. Both axes should be quantitative. */
  scatter(args: {
    data: ReadonlyArray<Record<string, unknown>>;
    x: string;
    y: string;
    color?: string;
    title?: string;
    name?: string;
  }): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: "scatter";
  }>;

  /** Histogram. \`y\` is omitted — counts are computed automatically. */
  histogram(args: {
    data: ReadonlyArray<Record<string, unknown>>;
    x: string;
    title?: string;
    name?: string;
    /** Number of bins (default 30). */
    bins?: number;
  }): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: "histogram";
  }>;

  /** Custom Vega-Lite v5 spec. The spec is validated and stored as-is. */
  spec(args: {
    spec: Record<string, unknown>;
    title?: string;
    name?: string;
  }): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: "custom";
  }>;
};
`;

  const bar = async (raw: unknown) => {
    const args = validateBaseArgs(raw);
    return chartArtifactRef(agent, { ...args, chartType: "bar" }, buildSimpleSpec(args, "bar"));
  };
  const line = async (raw: unknown) => {
    const args = validateBaseArgs(raw);
    return chartArtifactRef(agent, { ...args, chartType: "line" }, buildSimpleSpec(args, "line"));
  };
  const scatter = async (raw: unknown) => {
    const args = validateBaseArgs(raw);
    return chartArtifactRef(
      agent,
      { ...args, chartType: "scatter" },
      buildSimpleSpec(args, "point")
    );
  };
  const histogram = async (raw: unknown) => {
    const a = raw as {
      data?: unknown;
      x?: unknown;
      bins?: unknown;
      title?: unknown;
      name?: unknown;
    };
    if (!Array.isArray(a?.data)) throw new Error("chart.histogram: `data` array required");
    if (typeof a.x !== "string") throw new Error("chart.histogram: `x` (field name) required");
    const bins = typeof a.bins === "number" ? a.bins : 30;
    const spec = {
      ...vegaLiteBase(typeof a.title === "string" ? a.title : undefined),
      data: { values: a.data },
      mark: "bar",
      encoding: {
        x: { field: a.x, type: "quantitative", bin: { maxbins: bins }, title: a.x },
        y: { aggregate: "count", type: "quantitative", title: "count" },
      },
    };
    return chartArtifactRef(
      agent,
      {
        title: typeof a.title === "string" ? a.title : undefined,
        name: typeof a.name === "string" ? a.name : undefined,
        chartType: "histogram",
      },
      spec
    );
  };
  const spec = async (raw: unknown) => {
    const a = raw as Partial<SpecArgs>;
    if (!a?.spec || typeof a.spec !== "object") {
      throw new Error("chart.spec: `spec` must be a Vega-Lite v5 spec object");
    }
    const merged = { ...vegaLiteBase(a.title), ...a.spec };
    return chartArtifactRef(
      agent,
      {
        title: a.title,
        name: a.name,
        chartType: "custom",
      },
      merged
    );
  };

  return {
    name: "chart",
    types,
    positionalArgs: false, // chart.bar({...}) — single object arg
    tools: {
      bar: {
        description: "Bar chart from rows. Returns a chart artifact reference.",
        execute: async (args: unknown) => bar(args),
      },
      line: {
        description: "Line chart from rows. Use a temporal x for time-series.",
        execute: async (args: unknown) => line(args),
      },
      scatter: {
        description: "Scatter plot. Both axes quantitative.",
        execute: async (args: unknown) => scatter(args),
      },
      histogram: {
        description: "Histogram of a single quantitative field.",
        execute: async (args: unknown) => histogram(args),
      },
      spec: {
        description: "Save a custom Vega-Lite v5 spec as a chart artifact.",
        execute: async (args: unknown) => spec(args),
      },
    },
  };
}
