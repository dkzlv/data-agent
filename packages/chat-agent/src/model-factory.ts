/**
 * Chat-model factory + AI Gateway wiring.
 *
 * Two paths:
 *
 * 1. **Workers AI** (`@cf/...` ids). Uses the platform `AI` binding,
 *    optionally proxied through `AI_GATEWAY_ID`. Used by the
 *    title-summarizer (cheap, deterministic) and any chat that
 *    overrides `CHAT_MODEL` to a `@cf/` model.
 *
 * 2. **Anthropic via the gateway's native endpoint**
 *    (`anthropic/...`). The gateway exposes
 *    `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/anthropic`
 *    which proxies to Anthropic's Messages API. With Stored Keys
 *    (BYOK) the gateway injects the real Anthropic key, and we
 *    authenticate to the gateway via `cf-aig-authorization`.
 *
 *    Earlier we used the gateway's OpenAI-compat endpoint
 *    (`/compat/chat/completions`) so a single `createOpenAI`
 *    instance could speak to any provider. Trade-off: the compat
 *    layer **strips Anthropic's `cache_control`** field, which
 *    means we couldn't enable prompt caching for the static
 *    `tools + system` prefix that costs ~2-4k input tokens per
 *    turn. Switching to the native endpoint via `@ai-sdk/anthropic`
 *    preserves provider-specific options like `cacheControl` (see
 *    AGENTS.md decision #16). OpenAI-compat is still reachable for
 *    e.g. `openai/...` ids if we ever need it, but the production
 *    path is now Anthropic-native.
 *
 * The factory returns the resolved model id alongside the model so
 * the caller can stamp it on log/audit envelopes without reading a
 * side-effect field.
 */
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Env } from "./env";

/**
 * Default chat model. Anthropic Claude Opus 4.7 routed through CF AI
 * Gateway's native Anthropic endpoint in BYOK mode. The gateway
 * holds the Anthropic key in its stored-keys vault and injects it on
 * every relayed request — our worker only carries the gateway
 * bearer (`cf-aig-authorization`).
 *
 * Model id format: `anthropic/{model}`. Set `CHAT_MODEL` in vars to
 * override (e.g. `anthropic/claude-sonnet-4-5`). The Workers AI
 * binding path (`@cf/...`) is preserved for the title-summarizer
 * which doesn't justify Claude Opus pricing.
 */
export const DEFAULT_MODEL = "anthropic/claude-opus-4-7";

export interface ModelFactoryInputs {
  env: Env;
  chatId: string;
  tenantId: string | null;
  userId: string | null;
  /** DO id, used for Workers AI session affinity (KV-prefix cache). */
  sessionAffinity: string;
  /**
   * Pre-resolved CF AI Gateway bearer. Resolved in the agent's
   * constructor via `blockConcurrencyWhile` so this sync factory
   * doesn't have to await secrets.
   *
   * Null in local dev when `CF_AIG_TOKEN` isn't bound — the gateway
   * endpoint will 401 loudly, which is the right signal.
   */
  resolvedAigToken: string | null;
}

export interface ModelFactoryResult {
  modelId: string;
  model: LanguageModel;
}

/**
 * Build the model for a turn. Returns the resolved id alongside so
 * the caller can stamp it on log/audit envelopes without redoing
 * the env-var lookup (or reading a side-effect field).
 */
export function buildChatModel(inputs: ModelFactoryInputs): ModelFactoryResult {
  const modelId = inputs.env.CHAT_MODEL ?? DEFAULT_MODEL;
  const gatewayId = inputs.env.AI_GATEWAY_ID;

  // Workers AI path: namespace prefix `@cf/`. Pre-Claude default.
  // Title-summarizer always routes through this regardless of chat
  // model — it has its own llama-3.1-8b override (see title-summarizer.ts).
  if (modelId.startsWith("@cf/")) {
    const workersai = createWorkersAI({ binding: inputs.env.AI });
    const gateway = gatewayId
      ? {
          id: gatewayId,
          metadata: {
            tenantId: inputs.tenantId ?? "unknown",
            chatId: inputs.chatId,
            userId: inputs.userId ?? "unknown",
            model: modelId,
          },
        }
      : undefined;
    const model = workersai(modelId, {
      sessionAffinity: inputs.sessionAffinity,
      chat_template_kwargs: {
        enable_thinking: true,
        clear_thinking: false,
      },
      ...(gateway ? { gateway } : {}),
    });
    return { modelId, model };
  }

  // Anthropic via CF AI Gateway native endpoint. Trim the
  // `anthropic/` prefix because `createAnthropic()(...)` already
  // namespaces requests (the path becomes `/v1/messages`, the model
  // id ends up in the request body as plain `claude-opus-4-7`).
  const accountId = inputs.env.CF_ACCOUNT_ID;
  const baseURL =
    gatewayId && accountId
      ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`
      : undefined;

  // BYOK auth: the gateway is the *outer* authenticator; it
  // substitutes the real Anthropic key from its stored-keys vault
  // when relaying. We authenticate to the gateway via
  // `cf-aig-authorization`, leave `apiKey` as a placeholder so the
  // SDK's `x-api-key` header isn't empty (the gateway ignores it),
  // and attach `cf-aig-metadata` for slice-by-tenant log filtering.
  //
  // The provider also accepts a top-level `headers` option that's
  // applied to every request — that's where our gateway bearer
  // lives. Without `cf-aig-authorization` the gateway returns 401
  // ("authenticated mode") even though the BYOK Anthropic key is
  // configured.
  const headers: Record<string, string> = {};
  if (inputs.resolvedAigToken) {
    headers["cf-aig-authorization"] = `Bearer ${inputs.resolvedAigToken}`;
  }
  if (gatewayId) {
    headers["cf-aig-metadata"] = JSON.stringify({
      tenantId: inputs.tenantId ?? "unknown",
      chatId: inputs.chatId,
      userId: inputs.userId ?? "unknown",
      model: modelId,
    });
  }

  const anthropic = createAnthropic({
    // Real provider key never leaves CF — the gateway injects it.
    // SDK requires *some* value or it falls back to env vars and
    // logs a noisy warning, so we feed it a constant string that
    // makes the source obvious in any leaked log line.
    apiKey: "byok-via-cf-aig",
    ...(baseURL ? { baseURL } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  });

  const bareModelId = modelId.replace(/^anthropic\//, "");
  return { modelId, model: anthropic(bareModelId) };
}
