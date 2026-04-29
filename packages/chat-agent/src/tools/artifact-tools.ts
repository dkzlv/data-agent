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
 *   const c = await chart.save({
 *     $schema: "https://vega.github.io/schema/vega-lite/v5.json",
 *     data: { values: rows },
 *     mark: "bar",
 *     encoding: {
 *       x: { field: "category", type: "nominal" },
 *       y: { field: "revenue", type: "quantitative" },
 *     },
 *   }, "Top customers");
 *
 * Both return `{ id, url, name, mime, kind }`. The URL points at
 *   /api/chats/<chatId>/artifacts/<id>
 * which is served from the ChatAgent's fetch() handler with strong
 * caching headers (artifacts are immutable once created).
 *
 * `chart.save` accepts a Vega-Lite v5 spec object. We give the model
 * the fewest possible inputs because Claude reliably writes correct
 * specs from the schema documentation alone — earlier we shipped 5
 * chart-type wrappers + a separate `vegaLite.*` validator namespace,
 * which together added ~3k chars of tool docs we never recouped in
 * better outputs.
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
  /** For charts: the canonical chart "type" — `"custom"` since
   *  `chart.save` accepts arbitrary specs. Kept on the ref so existing
   *  audit + UI consumers (which key off `chartType`) stay unchanged. */
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
   *  reference with a URL the chat UI uses to render it. Use this for
   *  long-form findings (markdown), data exports (csv/tsv/json), or any
   *  text payload the user should be able to download. */
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

const VEGA_LITE_SCHEMA_URL = "https://vega.github.io/schema/vega-lite/v5.json";

/** Sensible Vega-Lite defaults merged into every spec. `width: "container"`
 *  matches the chat artifact viewer's `fullWidth` mode (see
 *  `web/src/components/ArtifactViewer.tsx`). */
const VEGA_LITE_DEFAULTS = {
  $schema: VEGA_LITE_SCHEMA_URL,
  width: "container",
  height: 320,
  autosize: { type: "fit", contains: "padding" } as const,
};

/**
 * Lightweight structural sanity check on a Vega-Lite spec. We don't
 * ship the full vega-lite schema validator (~1.5 MB) — the rendered
 * chart will surface real errors. This catches the common mistakes
 * (non-object spec, missing mark, missing data) early so the model
 * gets an actionable error instead of an empty chart.
 *
 * Inlined from the old `vegaLite.validate` tool that was removed
 * along with its namespace — only the chart save path needed it.
 */
function sanityCheckSpec(spec: unknown): { ok: true } | { ok: false; reason: string } {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, reason: "spec must be a non-array object" };
  }
  const s = spec as Record<string, unknown>;
  const composers = ["layer", "concat", "hconcat", "vconcat", "facet", "repeat", "spec"];
  const hasComposer = composers.some((k) => k in s);
  if (!hasComposer && s.mark === undefined) {
    return {
      ok: false,
      reason:
        "spec must define `mark` (e.g. 'bar', 'line', 'point') or a composition (`layer`, `concat`, etc.)",
    };
  }
  if (!hasComposer && !s.data && s.datasets === undefined) {
    return {
      ok: false,
      reason: "missing `data` — supply `{ values: [...] }` or `{ url: '…' }`",
    };
  }
  return { ok: true };
}

export function chartTools(agent: AgentLike): ToolProvider {
  const types = `
declare const chart: {
  /** Persist a Vega-Lite v5 spec as a chart artifact. The spec is
   *  merged with sensible defaults (\`$schema\`, \`width: "container"\`,
   *  \`height: 320\`) and validated structurally before being written.
   *  Returns a chart artifact reference.
   *
   *  Provide a complete spec including \`data\`, \`mark\`, and \`encoding\`.
   *  The optional second argument is the user-visible artifact name
   *  (defaults to the spec's \`title\` or "chart"). */
  save(
    spec: Record<string, unknown>,
    name?: string
  ): Promise<{
    id: string; name: string; mime: string; kind: "chart";
    url: string; createdAt: string; size: number; chartType: string;
  }>;
};
`;

  const save = async (rawSpec: unknown, rawName: unknown): Promise<ArtifactRef> => {
    const check = sanityCheckSpec(rawSpec);
    if (!check.ok) {
      throw new Error(`chart.save: invalid Vega-Lite spec — ${check.reason}`);
    }
    const userSpec = rawSpec as Record<string, unknown>;
    // Defaults first, user spec wins on conflicts. Title comes only
    // from the user spec (no synthetic title injection).
    const merged: Record<string, unknown> = { ...VEGA_LITE_DEFAULTS, ...userSpec };
    const title = typeof userSpec.title === "string" ? userSpec.title : undefined;
    const explicitName = typeof rawName === "string" ? rawName : undefined;
    const baseName = sanitizeName(explicitName ?? title ?? "chart");
    const name = baseName.endsWith(".vl.json") ? baseName : `${baseName}.vl.json`;
    const json = JSON.stringify(merged, null, 2);
    return persistArtifact(
      agent,
      {
        id: crypto.randomUUID(),
        name,
        mime: "application/vnd.vegalite.v5+json",
        kind: "chart",
        size: json.length,
        createdAt: new Date().toISOString(),
        chartType: "custom",
      },
      json
    );
  };

  return {
    name: "chart",
    types,
    positionalArgs: true,
    tools: {
      save: {
        description: "Persist a Vega-Lite v5 spec as a chart artifact.",
        execute: async (...args: unknown[]) => save(args[0], args[1]),
      },
    },
  };
}
