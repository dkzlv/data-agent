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
 * 2. **External provider via AI Gateway compat** (`anthropic/...`,
 *    `openai/...`). The gateway exposes an OpenAI-shaped
 *    `/compat/chat/completions` endpoint that proxies any provider
 *    in BYOK mode. Default chat model is `anthropic/claude-opus-4-7`
 *    via this path: the gateway holds the Anthropic key in its
 *    stored-keys vault and injects it on every relayed request.
 *
 *    PR #12 (commit d1ec6f0, "[722e12]") briefly switched this path
 *    to the gateway's native Anthropic endpoint via
 *    `@ai-sdk/anthropic` to enable Anthropic prompt caching
 *    (`cache_control`). That broke production with 401s within
 *    ~20 minutes of merge — the auth shape changed from
 *    `Authorization: Bearer <CF_AIG_TOKEN>` (compat) to
 *    `cf-aig-authorization: Bearer <CF_AIG_TOKEN>` (native), and the
 *    stored CF_AIG_TOKEN didn't have the right scope or the gateway
 *    auth-mode setting didn't match. Rolled back to the compat
 *    endpoint here while keeping the rest of PR #12 (harness trim,
 *    chart.* collapse, system-prompt rewrite) which was unrelated.
 *    Re-enabling prompt caching is a future task — needs a verified
 *    gateway auth setup first. The `cacheControl` provider option in
 *    `tools/build.ts` is left in place: compat ignores unknown
 *    providerOptions, so it's a no-op until we move back to native.
 *
 * The factory returns the resolved model id alongside the model so
 * the caller can stamp it on log/audit envelopes without reading a
 * side-effect field.
 */
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import type { Env } from "./env";

/**
 * Default chat model. Anthropic Claude Opus 4.7 routed through CF AI
 * Gateway's OpenAI-compatible endpoint in BYOK mode. The compat
 * endpoint gives us a single OpenAI-shaped surface for all providers,
 * so swapping models (or providers) is a config change, not a code
 * one. Set `CHAT_MODEL` in vars to override.
 *
 * Model id format on the compat endpoint is `{provider}/{model}`:
 *   - `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-5`
 *   - `openai/gpt-5.2`, `openai/gpt-4.1-mini`
 *
 * The Workers AI binding path (`@cf/...`) is preserved for the
 * title-summarizer which doesn't justify Claude Opus pricing.
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
   * Null in local dev when `CF_AIG_TOKEN` isn't bound — the compat
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

  // External provider via CF AI Gateway's OpenAI-compatible endpoint
  // (`/compat/chat/completions`). This gives us:
  //   - Single auth header (`Authorization: Bearer <CF_AIG_TOKEN>`)
  //     instead of provider-specific headers + cf-aig-authorization.
  //   - One client surface for all providers — switching from
  //     `anthropic/...` to `openai/...` is a CHAT_MODEL var change,
  //     no code edits.
  //   - Stored Keys (BYOK) is applied transparently by the gateway:
  //     it injects the provider's real API key from its vault before
  //     relaying. Our request never carries the Anthropic key.
  //
  // Per-request metadata still goes via `cf-aig-metadata` header so
  // gateway-log slicing by tenant/chat/user matches what the Workers
  // AI binding path produces.
  const accountId = inputs.env.CF_ACCOUNT_ID;
  const baseURL =
    gatewayId && accountId
      ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`
      : undefined;

  const headers: Record<string, string> = {};
  if (gatewayId) {
    headers["cf-aig-metadata"] = JSON.stringify({
      tenantId: inputs.tenantId ?? "unknown",
      chatId: inputs.chatId,
      userId: inputs.userId ?? "unknown",
      model: modelId,
    });
  }

  // CF_AIG_TOKEN is REQUIRED in production (gateway is authenticated).
  // In local dev without the secret bound we fall through to whatever
  // is in apiKey — a noisy 401 is fine, it's an explicit signal to
  // populate `.dev.vars`.
  const apiKey = inputs.resolvedAigToken ?? "missing-cf-aig-token";

  const openai = createOpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  });

  // `openai.chat(...)` selects the chat-completions surface, which is
  // what the AI Gateway compat endpoint speaks. `openai(...)` /
  // `openai.responses(...)` would target the Responses API which the
  // gateway doesn't proxy.
  return { modelId, model: openai.chat(modelId) };
}
