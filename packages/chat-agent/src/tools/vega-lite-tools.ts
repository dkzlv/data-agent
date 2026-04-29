/**
 * `vegaLite.*` ToolProvider — gives the LLM a small validation +
 * reference helper for assembling Vega-Lite v5 specs by hand.
 *
 * We *don't* bundle the full vega-lite npm package into the codemode
 * sandbox (subtask abe549). The runtime is ~1.5 MB shipped, and we
 * only need to *generate* specs in the agent — rendering happens in
 * the browser (via vega-embed) and we already give the LLM
 * declarative `chart.bar / .line / .scatter / .histogram / .spec`
 * helpers that build a correct spec from a small set of inputs.
 *
 * What this provider DOES give the LLM:
 *
 *   await vegaLite.validate(spec)   →  { ok, errors }     // structural
 *   vegaLite.schemaUrl()            →  "https://vega.github.io/schema/vega-lite/v5.json"
 *   vegaLite.examples.bar()         →  reference example object
 *   vegaLite.examples.line()
 *   vegaLite.examples.scatter()
 *   vegaLite.examples.layered()
 *
 * The validator runs locally — no network. Errors are short, actionable
 * strings the LLM can use to self-correct in the next turn.
 *
 * If a future user genuinely needs the vega-lite TS API in the sandbox
 * (e.g. composing nested specs programmatically), we can ship the npm
 * bundle via `DynamicWorkerExecutorOptions.modules`. That capability is
 * untouched by this provider.
 */
import type { ToolProvider } from "@cloudflare/codemode";

const SCHEMA_URL = "https://vega.github.io/schema/vega-lite/v5.json";

const VALID_MARKS = new Set([
  "bar",
  "line",
  "point",
  "circle",
  "square",
  "tick",
  "rect",
  "rule",
  "area",
  "text",
  "trail",
  "boxplot",
  "errorbar",
  "errorband",
  "geoshape",
  "image",
  "arc",
]);

const VALID_TYPES = new Set(["quantitative", "ordinal", "nominal", "temporal", "geojson"]);

const VALID_AGGREGATES = new Set([
  "count",
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "stdev",
  "stdevp",
  "variance",
  "variancep",
  "missing",
  "valid",
  "distinct",
  "argmin",
  "argmax",
]);

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/**
 * Lightweight structural validator for Vega-Lite v5 specs. Catches the
 * common mistakes the LLM makes (misspelled mark, wrong type code,
 * missing required fields). Returns a list of plain-language errors.
 *
 * This is a *fast* check for use during code generation. It does not
 * replicate the full vega-lite schema (which has ~3000 rules); for
 * authoritative validation, the rendered chart will surface real errors.
 */
export function validateSpec(spec: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {
      ok: false,
      errors: [{ path: "$", message: "spec must be a non-array object" }],
    };
  }
  const s = spec as Record<string, unknown>;

  // $schema is optional but if present must be a vega-lite v5 URL
  const schema = s.$schema;
  if (typeof schema === "string" && !schema.includes("vega-lite/v5")) {
    errors.push({
      path: "$.$schema",
      message: `expected vega-lite v5 schema URL, got "${schema}"`,
    });
  }

  // Either `mark` or `layer` (or `concat`/`hconcat`/`vconcat`/`facet`/`repeat`/`spec`) at top level
  const composers = ["layer", "concat", "hconcat", "vconcat", "facet", "repeat", "spec"];
  const hasComposer = composers.some((k) => k in s);
  if (!hasComposer && s.mark === undefined) {
    errors.push({
      path: "$.mark",
      message:
        "spec must define `mark` (e.g. 'bar', 'line', 'point') OR a composition (`layer`, `concat`, `hconcat`, `vconcat`, `facet`, `repeat`).",
    });
  }

  if (s.mark !== undefined) {
    const markType =
      typeof s.mark === "string"
        ? s.mark
        : typeof s.mark === "object" && s.mark !== null
          ? (s.mark as Record<string, unknown>).type
          : undefined;
    if (typeof markType === "string" && !VALID_MARKS.has(markType)) {
      errors.push({
        path: "$.mark",
        message: `unknown mark "${markType}". Common: bar, line, point, area, rect, text, rule, arc, boxplot, errorbar.`,
      });
    } else if (markType === undefined) {
      errors.push({
        path: "$.mark",
        message: "mark must be a string or { type: '...' } object.",
      });
    }
  }

  // Data is required for non-composed specs
  if (!hasComposer && !s.data && s.datasets === undefined) {
    errors.push({
      path: "$.data",
      message:
        "missing `data` — supply `{ values: [...] }` for inline data or `{ url: '…' }` for a remote dataset.",
    });
  }

  // Validate encoding fields if present
  if (s.encoding !== undefined) {
    if (typeof s.encoding !== "object" || s.encoding === null) {
      errors.push({ path: "$.encoding", message: "encoding must be an object" });
    } else {
      const enc = s.encoding as Record<string, unknown>;
      for (const [channel, def] of Object.entries(enc)) {
        if (def == null) continue;
        if (typeof def !== "object") {
          errors.push({
            path: `$.encoding.${channel}`,
            message: "must be an object (e.g. { field, type })",
          });
          continue;
        }
        const d = def as Record<string, unknown>;
        if (d.type !== undefined && typeof d.type === "string" && !VALID_TYPES.has(d.type)) {
          errors.push({
            path: `$.encoding.${channel}.type`,
            message: `unknown type "${d.type}". Use: quantitative | ordinal | nominal | temporal.`,
          });
        }
        if (
          d.aggregate !== undefined &&
          typeof d.aggregate === "string" &&
          !VALID_AGGREGATES.has(d.aggregate)
        ) {
          errors.push({
            path: `$.encoding.${channel}.aggregate`,
            message: `unknown aggregate "${d.aggregate}". Use: sum | mean | median | min | max | count.`,
          });
        }
        // Field references — if `aggregate` is "count" no field is required, otherwise expect one
        if (
          d.aggregate !== "count" &&
          d.field === undefined &&
          d.value === undefined &&
          d.datum === undefined
        ) {
          errors.push({
            path: `$.encoding.${channel}`,
            message: "channel must have one of `field`, `value`, `datum`, or `aggregate: 'count'`.",
          });
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

const VEGALITE_TYPES = `
declare const vegaLite: {
  /** Validate a Vega-Lite v5 spec object structurally. Returns
   *  \`{ ok, errors }\`; errors are plain strings the LLM can use to
   *  self-correct. This is *not* full schema validation — for that, the
   *  rendered chart will surface remaining issues. */
  validate(spec: Record<string, unknown>): Promise<{
    ok: boolean;
    errors: Array<{ path: string; message: string }>;
  }>;

  /** The canonical Vega-Lite v5 schema URL — use as the \`$schema\` field. */
  schemaUrl(): Promise<string>;

  /** Reference example specs to seed your structure. */
  exampleBar(): Promise<Record<string, unknown>>;
  exampleLine(): Promise<Record<string, unknown>>;
  exampleScatter(): Promise<Record<string, unknown>>;
  exampleLayered(): Promise<Record<string, unknown>>;
};
`;

const examples = {
  bar: () =>
    ({
      $schema: SCHEMA_URL,
      title: "Sample bar chart",
      data: {
        values: [
          { category: "A", value: 28 },
          { category: "B", value: 55 },
          { category: "C", value: 43 },
        ],
      },
      mark: "bar",
      encoding: {
        x: { field: "category", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    }) satisfies Record<string, unknown>,
  line: () => ({
    $schema: SCHEMA_URL,
    data: {
      values: [
        { date: "2025-01-01", price: 10 },
        { date: "2025-02-01", price: 12 },
        { date: "2025-03-01", price: 15 },
      ],
    },
    mark: "line",
    encoding: {
      x: { field: "date", type: "temporal" },
      y: { field: "price", type: "quantitative" },
    },
  }),
  scatter: () => ({
    $schema: SCHEMA_URL,
    data: { values: [] },
    mark: { type: "point", filled: true },
    encoding: {
      x: { field: "horsepower", type: "quantitative" },
      y: { field: "mpg", type: "quantitative" },
      color: { field: "origin", type: "nominal" },
    },
  }),
  layered: () => ({
    $schema: SCHEMA_URL,
    data: { values: [] },
    layer: [
      {
        mark: "line",
        encoding: {
          x: { field: "date", type: "temporal" },
          y: { field: "value", type: "quantitative" },
        },
      },
      {
        mark: "rule",
        encoding: { y: { aggregate: "mean", field: "value" } },
      },
    ],
  }),
};

export function vegaLiteTools(): ToolProvider {
  return {
    name: "vegaLite",
    types: VEGALITE_TYPES,
    positionalArgs: false,
    tools: {
      validate: {
        description: "Structurally validate a Vega-Lite v5 spec object.",
        execute: async (spec: unknown) => validateSpec(spec),
      },
      schemaUrl: {
        description: "Return the canonical Vega-Lite v5 schema URL.",
        execute: async () => SCHEMA_URL,
      },
      exampleBar: {
        description: "A sample bar chart spec.",
        execute: async () => examples.bar(),
      },
      exampleLine: {
        description: "A sample line chart spec.",
        execute: async () => examples.line(),
      },
      exampleScatter: {
        description: "A sample scatter plot spec.",
        execute: async () => examples.scatter(),
      },
      exampleLayered: {
        description: "A sample layered (line + mean rule) spec.",
        execute: async () => examples.layered(),
      },
    },
  };
}
