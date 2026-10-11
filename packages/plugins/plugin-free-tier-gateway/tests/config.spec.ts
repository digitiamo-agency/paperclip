import { describe, expect, it } from "vitest";
import { configErrors, parseConfig } from "../src/config.js";

describe("config", () => {
  it("reads key slots and derives stable ids and secret paths", () => {
    const cfg = parseConfig({
      key1: { provider: "groq", label: "main", apiKey: { type: "secret_ref", secretId: "x" } },
      key3: { provider: "groq", apiKey: "ref2" },
      key2: { provider: "gemini" },
    });
    expect(cfg.keys.map((k) => [k.id, k.configPath])).toEqual([
      ["groq:main", "key1.apiKey"],
      ["groq:key3", "key3.apiKey"],
    ]);
  });

  it("reports duplicate labels and unknown targets", () => {
    const cfg = parseConfig({
      key1: { provider: "groq", label: "a", apiKey: "r" },
      key2: { provider: "groq", label: "a", apiKey: "r" },
      virtualModels: { fast: ["nope/x", "groq/ok"] },
    });
    expect(configErrors(cfg)).toEqual([
      "duplicate key label: groq:a",
      'virtual model "fast": unknown target "nope/x"',
    ]);
  });

  it("requires a valid accountId for Cloudflare keys", () => {
    const bad = parseConfig({ key1: { provider: "cloudflare", apiKey: "r" }, key2: { provider: "cloudflare", label: "b", accountId: "nope", apiKey: "r" } });
    expect(configErrors(bad)).toEqual([
      "cloudflare:key1: cloudflare needs a 32-character hexadecimal accountId",
      "cloudflare:b: cloudflare needs a 32-character hexadecimal accountId",
    ]);
    const good = parseConfig({ key1: { provider: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", apiKey: "r" } });
    expect(configErrors(good)).toEqual([]);
  });

  it("applies provider budgets and lets a key override or switch them off", () => {
    const cfg = parseConfig({
      key1: { provider: "mistral", apiKey: "r" },
      key2: { provider: "groq", label: "x", apiKey: "r", rpm: 5, tpd: 0 },
      key3: { provider: "cloudflare", accountId: "0123456789abcdef0123456789abcdef", apiKey: "r" },
    });
    expect(cfg.keys.map((k) => k.limits)).toEqual([
      { rpm: 2, rpd: 1000, tpd: 30_000_000 },
      { rpm: 5, rpd: 1000, tpd: 0 },
      {},
    ]);
  });

  it("reads and validates the auto router", () => {
    const ok = parseConfig({
      routerModel: "free-fast",
      routerDescriptions: { "free-fast": "short", "free-smart": "hard" },
      virtualModels: { "free-fast": ["groq/a"], "free-smart": ["gemini/b"] },
    });
    expect(ok.router?.model).toBe("free-fast");
    expect(configErrors(ok)).toEqual([]);

    const bad = parseConfig({
      routerModel: "nope",
      routerDescriptions: { ghost: "x" },
      virtualModels: { a: ["groq/a"] },
    });
    expect(configErrors(bad)).toEqual([
      'routerModel "nope" is neither a virtual model nor a provider/model target',
      'routerDescriptions: unknown virtual model "ghost"',
    ]);
    expect(parseConfig({ routerModel: "free-fast" }).router).toBeUndefined();
  });

  it("rejects known paid targets unless allowPaidModels is set", () => {
    const virtualModels = { a: ["requesty/openai/gpt-4o"], b: ["openrouter/openai/gpt-4o:free", "openrouter/meta/llama"] };
    expect(configErrors(parseConfig({ virtualModels }))).toEqual([
      'virtual model "a": "requesty/openai/gpt-4o" is not a known free model (set allowPaidModels to use it)',
      'virtual model "b": "openrouter/meta/llama" is not a known free model (set allowPaidModels to use it)',
    ]);
    expect(configErrors(parseConfig({ virtualModels, allowPaidModels: true }))).toEqual([]);
  });

  it("offers twelve key slots", () => {
    expect(parseConfig({ key12: { provider: "groq", apiKey: "r" } }).keys.map((k) => k.configPath)).toEqual(["key12.apiKey"]);
  });
});
