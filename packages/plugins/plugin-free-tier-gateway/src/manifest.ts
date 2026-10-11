import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { KEY_SLOTS } from "./config.js";
import { PROVIDERS } from "./providers.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.free-tier-gateway",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Free-tier LLM Gateway",
  description:
    "Runs a local OpenAI-compatible gateway that pools official free-tier API keys with rate-limit rotation and provider failover.",
  author: "Paperclip",
  categories: ["connector", "ui"],
  capabilities: ["http.outbound", "network.listen.loopback", "secrets.read-ref", "plugin.state.read", "plugin.state.write", "ui.dashboardWidget.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "free-tier-gateway-status",
        displayName: "Free-tier Gateway",
        exportName: "GatewayStatusWidget",
      },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      ...Object.fromEntries(
        KEY_SLOTS.map((slot, n) => [
          slot,
          {
            type: "object",
            description: `API key slot ${n + 1}. Official keys issued by a provider for API use.`,
            properties: {
              provider: {
                type: "string",
                enum: Object.keys(PROVIDERS),
                description: `Free API key sources: ${Object.entries(PROVIDERS).map(([id, p]) => `${id} (${p.signupUrl})`).join(", ")}`,
              },
              label: { type: "string", description: "Name shown in status output." },
              rpm: { type: "number", description: "Requests per minute for this key. Overrides the provider default; 0 disables the budget." },
              rpd: { type: "number", description: "Requests per UTC day for this key. Overrides the provider default; 0 disables the budget." },
              tpd: { type: "number", description: "Tokens per UTC day for this key (non-streamed responses only). Overrides the provider default; 0 disables the budget." },
              accountId: { type: "string", description: "Cloudflare account id (32 hex characters). Required for the cloudflare provider; not a secret." },
              apiKey: { type: ["string", "object"], format: "secret-ref" },
            },
          },
        ]),
      ),
      allowPaidModels: {
        type: "boolean",
        description:
          "Off by default. The gateway refuses targets known to be billed (OpenRouter without :free, Requesty outside its free list). Turn on only if you want it to spend credits.",
        default: false,
      },
      routerModel: {
        type: "string",
        description:
          "Enables the `auto` model: a small, fast virtual model or provider/model that picks which described virtual model should answer. Costs one extra request per call.",
      },
      routerDescriptions: {
        type: "object",
        description: "Virtual model name -> what it is good at. Only described models can be chosen by `auto`.",
        additionalProperties: { type: "string" },
      },
      virtualModels: {
        type: "object",
        description:
          "Virtual model name -> ordered list of `provider/model` targets, tried in order. Example: {\"free-fast\": [\"groq/llama-3.3-70b-versatile\", \"cerebras/llama-3.3-70b\"]}.",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export default manifest;
