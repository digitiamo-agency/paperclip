import type { Limits } from "./pool.js";

/** Official OpenAI-compatible endpoints of providers that offer a free API tier. */
export interface ProviderInfo {
  baseUrl: string;
  /**
   * Conservative per-key budgets for the free tier, used to avoid provider 429s.
   * Providers change them often; override per key with `rpm`/`rpd`/`tpd`.
   */
  limits?: Limits;
  /** Where an operator creates a free API key. */
  signupUrl: string;
  stripReasoning?: boolean;
}

export const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  gemini: { limits: { rpm: 10, rpd: 1500 }, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", signupUrl: "https://aistudio.google.com/apikey" },
  // Groq rejects `reasoning_content` on assistant messages that clients echo back.
  groq: { limits: { rpm: 30, rpd: 1000, tpd: 100_000 }, baseUrl: "https://api.groq.com/openai/v1", signupUrl: "https://console.groq.com/keys", stripReasoning: true },
  cerebras: { limits: { rpm: 30, rpd: 1000, tpd: 1_000_000 }, baseUrl: "https://api.cerebras.ai/v1", signupUrl: "https://cloud.cerebras.ai" },
  mistral: { limits: { rpm: 2, rpd: 1000, tpd: 30_000_000 }, baseUrl: "https://api.mistral.ai/v1", signupUrl: "https://console.mistral.ai/api-keys" },
  nvidia: { limits: { rpm: 40, rpd: 5000 }, baseUrl: "https://integrate.api.nvidia.com/v1", signupUrl: "https://build.nvidia.com" },
  github: { limits: { rpm: 15, rpd: 150 }, baseUrl: "https://models.github.ai/inference", signupUrl: "https://github.com/settings/tokens" },
  openrouter: { limits: { rpm: 20, rpd: 50 }, baseUrl: "https://openrouter.ai/api/v1", signupUrl: "https://openrouter.ai/settings/keys" },
  // Inference Providers router. Free accounts get a small monthly credit (no request
  // quota), so there is no local budget; an empty credit answers 402. Model ids may end
  // in ":provider" to pin a backend.
  huggingface: { baseUrl: "https://router.huggingface.co/v1", signupUrl: "https://huggingface.co/settings/tokens" },
  // Free plan: plugsky-micro and plugsky-lite, "limited API access" with no published
  // numbers, so no local budget; its limits show up as 429s.
  plugsky: { baseUrl: "https://plugsky.com/v1", signupUrl: "https://plugsky.com" },
  // Requesty gateway. Only the models in REQUESTY_FREE_MODELS are free; the free pool is
  // 200 requests/day and 20/minute per organization (new organizations), all keys combined.
  requesty: { limits: { rpm: 20, rpd: 200 }, baseUrl: "https://router.requesty.ai/v1", signupUrl: "https://app.requesty.ai" },
  // Workers AI's OpenAI-compatible endpoint is per account.
  cloudflare: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1", signupUrl: "https://dash.cloudflare.com/profile/api-tokens" },
};

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Requesty's free models, from docs.requesty.ai/features/free-models (checked 2026-10-11,
 * "free for now"). Everything else on that gateway is billed.
 */
const REQUESTY_FREE_MODELS: ReadonlySet<string> = new Set([
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "poolside/laguna-xs.2",
  "poolside/laguna-m.1",
  "google/gemma-4-31b-it",
  "mistral/leanstral-1-5",
  "nvidia/nemotron-3.5-content-safety",
]);

/**
 * False only for targets known to cost money on a gateway that mixes free and paid
 * models (OpenRouter without `:free`, anything on Requesty outside its free list).
 * Providers that are free in full, or credit-based as a whole, are not second-guessed.
 */
export function isFreeTarget(provider: string, model: string): boolean {
  if (provider === "openrouter") return model.endsWith(":free");
  if (provider === "requesty") return REQUESTY_FREE_MODELS.has(model);
  return true;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

export function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

/** Upstream base URL for a key, or undefined when a required account id is missing or malformed. */
export function upstreamBaseUrl(provider: string, accountId?: string): string | undefined {
  const template = PROVIDERS[provider]?.baseUrl;
  if (!template) return undefined;
  if (!template.includes("{accountId}")) return template;
  return isValidAccountId(accountId) ? template.replace("{accountId}", accountId) : undefined;
}

export function providerBaseUrl(provider: string): string | undefined {
  return PROVIDERS[provider]?.baseUrl;
}

/** A routing target such as `groq/llama-3.3-70b-versatile`. */
export interface Target {
  provider: string;
  model: string;
}

export function parseTarget(raw: string): Target | null {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  const provider = raw.slice(0, slash);
  if (!providerBaseUrl(provider)) return null;
  return { provider, model: raw.slice(slash + 1) };
}

/** Remove fields a provider rejects when a client echoes earlier assistant turns back. */
export function normalizeBody(provider: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!PROVIDERS[provider]?.stripReasoning || !Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: body.messages.map((m) => {
      if (!m || typeof m !== "object" || !("reasoning_content" in m || "reasoning" in m)) return m;
      const { reasoning_content: _rc, reasoning: _r, ...rest } = m as Record<string, unknown>;
      return rest;
    }),
  };
}

/** Parse "max_tokens must be <= N" style errors so the request can be retried within the limit. */
export function parseTokenLimit(errorText: string): number | null {
  const m = /(?:max_tokens|max_completion_tokens)[^\n]*?(?:less than or equal to|<=|at most)\s*`?(\d+)`?/i.exec(errorText);
  return m ? Number(m[1]) : null;
}
