import { describe, expect, it } from "vitest";
import { isFreeTarget, parseTarget, PROVIDERS, upstreamBaseUrl } from "../src/providers.js";

describe("providers", () => {
  it("only uses HTTPS endpoints and lists a signup link for each", () => {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      expect(p.baseUrl.startsWith("https://"), id).toBe(true);
      expect(p.signupUrl.startsWith("https://"), id).toBe(true);
    }
  });

  it("covers the free-tier providers", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(
      ["cerebras", "cloudflare", "gemini", "github", "groq", "huggingface", "mistral", "nvidia", "openrouter", "plugsky", "requesty"],
    );
  });

  it("splits provider from model on the first slash only", () => {
    expect(parseTarget("nvidia/meta/llama-3.3-70b-instruct")).toEqual({ provider: "nvidia", model: "meta/llama-3.3-70b-instruct" });
    expect(parseTarget("mistral/mistral-small-latest")).toEqual({ provider: "mistral", model: "mistral-small-latest" });
    expect(parseTarget("unknown/x")).toBeNull();
    expect(upstreamBaseUrl("mistral")).toBe("https://api.mistral.ai/v1");
  });

  it("knows which targets cost money on mixed gateways", () => {
    expect(isFreeTarget("openrouter", "nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(isFreeTarget("openrouter", "openai/gpt-4o")).toBe(false);
    expect(isFreeTarget("requesty", "nvidia/nemotron-3-super-120b-a12b")).toBe(true);
    expect(isFreeTarget("requesty", "openai/gpt-4o")).toBe(false);
    expect(isFreeTarget("groq", "anything")).toBe(true);
  });
});
