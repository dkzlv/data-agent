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

  // Secrets
  CONTROL_PLANE_DB_URL: SecretBinding;
  INTERNAL_JWT_SIGNING_KEY: SecretBinding;
  MASTER_ENCRYPTION_KEY: SecretBinding;

  // Bindings
  AI: Ai;
  LOADER: WorkerLoader;
  ARTIFACTS: R2Bucket;

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
