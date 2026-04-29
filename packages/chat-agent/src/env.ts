/**
 * ChatAgent worker environment bindings.
 */
export type SecretBinding = string | { get: () => Promise<string> };

export interface Env {
  // Vars
  APP_URL: string;
  API_URL: string;
  /** Optional override for the LLM. Set in wrangler vars or .dev.vars. */
  CHAT_MODEL?: string;
  /**
   * Cloudflare AI Gateway id to route Workers AI calls through. When
   * unset, calls go direct to Workers AI (no gateway dashboard, no
   * caching, no per-request cost telemetry). Set to e.g. `data-agent`
   * in wrangler.jsonc for production; leave unset in local dev.
   */
  AI_GATEWAY_ID?: string;
  /**
   * CF account id — needed to construct the AI Gateway base URL for
   * external providers. The gateway URL is
   * `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/compat`,
   * which the @ai-sdk/openai provider hits as `baseURL`. Set in
   * wrangler vars; mirrors the worker's `account_id`.
   */
  CF_ACCOUNT_ID?: string;

  // Secrets
  CONTROL_PLANE_DB_URL: SecretBinding;
  INTERNAL_JWT_SIGNING_KEY: SecretBinding;
  MASTER_ENCRYPTION_KEY: SecretBinding;
  /**
   * CF API token used as the AI Gateway authenticated bearer. The
   * compat endpoint accepts it as `Authorization: Bearer ...` (alias
   * for `cf-aig-authorization`). Required: our `data-agent` gateway
   * runs in authenticated mode, so requests without it 401 even
   * though the BYOK Anthropic key is stored in the gateway.
   *
   * Token needs the `AI Gateway → Run` permission on this account.
   * Distinct from `CLOUDFLARE_API_TOKEN` (scripts token) — that one
   * has Read scopes for log inspection but no Run.
   *
   * Workers AI binding calls (title-summarizer) are pre-authenticated
   * by the platform and skip this header entirely; only the external-
   * provider compat path uses it.
   */
  CF_AIG_TOKEN?: SecretBinding;

  // Bindings
  AI: Ai;
  LOADER: WorkerLoader;
  ARTIFACTS: R2Bucket;
  /**
   * Cross-chat memory vector index (task a0e754). Stores 768-d
   * embeddings of `memory_fact.content` keyed by fact id. Postgres
   * is the source of truth — Vectorize is the search index. Tenant
   * isolation is hard via the `namespace` arg on every query/upsert.
   *
   * `Vectorize` (V2 — async mutations) rather than the deprecated
   * beta `VectorizeIndex`. New indexes created via `wrangler
   * vectorize create` after the V2 GA bind to this class regardless
   * of how the binding is labelled in wrangler.jsonc.
   */
  VECTORIZE_MEMORY: Vectorize;

  // DO namespace (this worker hosts ChatAgent)
  CHAT_AGENT: DurableObjectNamespace;
}

/**
 * WorkerLoader binding shape — types not yet in @cloudflare/workers-types
 * (Dynamic Workers is GA but typings shipped late).
 */
export interface WorkerLoader {
  get(
    id: string,
    getCode: () => Promise<{
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string>;
      env?: Record<string, unknown>;
      globalOutbound?: Fetcher | null;
    }>
  ): { getEntrypoint(name?: string): Fetcher };

  load(code: {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    mainModule: string;
    modules: Record<string, string>;
    env?: Record<string, unknown>;
    globalOutbound?: Fetcher | null;
  }): { getEntrypoint(name?: string): Fetcher };
}

export async function readSecret(binding: SecretBinding): Promise<string> {
  return typeof binding === "string" ? binding : await binding.get();
}
