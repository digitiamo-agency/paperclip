import { z } from "zod";

/** True for localhost / loopback hostnames used by local model servers. */
export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

/**
 * True for RFC1918 private IPv4 hosts (10/8, 172.16/12, 192.168/16).
 * Used so LAN OpenAI-compatible servers (Ollama, internal gateways) can use HTTP.
 * Link-local and metadata addresses are intentionally excluded.
 */
export function isPrivateIpv4Hostname(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Endpoint URL rules for AI connection routing.
 * HTTPS anywhere; HTTP only on loopback, or (for gateways) private LAN IPv4.
 */
export function isAllowedAiEndpointUrl(
  raw: string,
  options: { allowPrivateHttp?: boolean } = {},
): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return false;
    const loopback = isLoopbackHostname(url.hostname);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      if (loopback) return true;
      if (options.allowPrivateHttp && isPrivateIpv4Hostname(url.hostname)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Value-free routing stored on the connection, never supplied by an agent binding. */
export const aiProviderRoutingSchema = z
  .object({
    kind: z.enum(["openrouter", "bedrock", "gateway", "local"]),
    protocol: z.enum(["responses", "messages", "chat", "bedrock"]),
    baseUrl: z.string().trim().max(2048).optional(),
    auth: z
      .enum(["bearer", "api_key", "none"])
      .default("bearer"),
    region: z
      .string()
      .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
      .optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(256),
            label: z.string().trim().max(160).optional(),
            /** OpenCode `provider.models.*.limit` — context window and max output tokens. */
            limit: z
              .object({
                context: z.number().int().positive().max(10_000_000),
                output: z.number().int().positive().max(10_000_000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((route, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (route.kind === "bedrock") {
      if (
        route.protocol !== "bedrock" ||
        !route.region ||
        route.auth !== "bearer" ||
        route.baseUrl
      )
        invalid(
          "Bedrock requires a region and a Bedrock API key.",
        );
    } else if (
      route.protocol === "bedrock" ||
      route.region
    )
      invalid("AWS settings require Bedrock.");
    if (
      route.kind === "openrouter" &&
      (route.baseUrl || route.auth !== "bearer")
    )
      invalid("OpenRouter uses its official endpoint and an API key.");
    if (route.auth === "api_key" && route.protocol !== "messages")
      invalid("API-key header authentication requires Anthropic Messages.");
    if (route.kind === "gateway" || route.kind === "local") {
      const allowPrivateHttp = route.kind === "gateway";
      if (
        !isAllowedAiEndpointUrl(route.baseUrl ?? "", { allowPrivateHttp })
      ) {
        invalid(
          "Enter an HTTPS base URL without credentials, query parameters, or a fragment. Loopback and private LAN endpoints may use HTTP.",
        );
        return;
      }
      if (
        route.kind === "local" &&
        !isLoopbackHostname(new URL(route.baseUrl ?? "").hostname)
      ) {
        invalid("A local endpoint must use localhost or a loopback address.");
      }
    }
  });
export type AiProviderRouting = z.infer<typeof aiProviderRoutingSchema>;
export function aiRoutingHarness(
  adapter: string,
  provider?: unknown,
  acpxAgent?: unknown,
): string {
  if (adapter !== "paperclip_runner") return adapter;
  const runner =
    provider === "acpx" && (acpxAgent === "claude" || acpxAgent === "grok")
      ? acpxAgent
      : provider;
  return (
    (
      {
        claude: "claude_local",
        codex: "codex_local",
        opencode: "opencode_local",
        grok: "grok_local",
      } as Record<string, string>
    )[String(runner)] ?? "unsupported"
  );
}
export function isAiRoutingCompatible(
  route: AiProviderRouting,
  harness: string,
): boolean {
  if (route.kind === "bedrock") return harness === "claude_local";
  if (route.kind === "openrouter")
    return [
      "claude_local",
      "codex_local",
      "opencode_local",
      "hermes_local",
    ].includes(harness);
  if (route.protocol === "responses") return harness === "codex_local";
  if (route.protocol === "messages") return harness === "claude_local";
  return ["opencode_local", "hermes_local"].includes(harness);
}
export function aiRoutingBaseUrl(
  route: AiProviderRouting,
  harness: string,
): string {
  return route.kind === "openrouter"
    ? `https://openrouter.ai/api${harness === "claude_local" ? "" : "/v1"}`
    : (route.baseUrl ?? "").replace(/\/+$/, "");
}

/** OpenCode names models with a provider prefix; other harnesses use the raw ID. */
export function aiRoutingModel(
  route: AiProviderRouting,
  harness: string,
  model: string,
): string {
  if (!model || harness !== "opencode_local") return model;
  const prefix = route.kind === "openrouter" ? "openrouter" : "paperclip";
  return model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`;
}

/** Catalog identity is derived from routing, including accounts saved before these rows existed. */
export function aiConnectionCatalogSlug(provider: string, routing?: Pick<AiProviderRouting, "kind" | "protocol">): string {
  if (routing?.kind === "gateway") {
    return routing.protocol === "messages" ? "messages-api"
      : routing.protocol === "chat" ? "chat-completions-api" : "responses-api";
  }
  return routing?.kind ?? provider;
}

/** Direct catalog setup presets; legacy gateway links still open their existing setup. */
export function aiProviderSetupPreset(source: string | null): {
  provider: "openrouter" | "bedrock" | "gateway" | "local" | "google";
  protocol?: AiProviderRouting["protocol"];
  label?: string;
} | undefined {
  switch (source) {
    case "responses-api": return { provider: "gateway", protocol: "responses", label: "Responses API" };
    case "messages-api": return { provider: "gateway", protocol: "messages", label: "Messages API" };
    case "chat-completions-api": return { provider: "gateway", protocol: "chat", label: "Chat Completions API" };
    case "google-ai": return { provider: "google" };
    case "google": case "openrouter": case "bedrock": case "gateway": case "local": return { provider: source };
    default: return undefined;
  }
}
