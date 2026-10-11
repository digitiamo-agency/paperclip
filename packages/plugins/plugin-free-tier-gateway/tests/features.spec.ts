import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPool, type PoolKey } from "../src/pool.js";
import { createGatewayServer, type RouterConfig, type Tenant } from "../src/proxy.js";

const TOKEN = "t";
const servers: ReturnType<typeof createGatewayServer>[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

type Call = { url: string; auth: string; body: Record<string, unknown> };

async function start(opts: {
  keys: PoolKey[];
  virtual: Record<string, string[]>;
  router?: RouterConfig;
  now?: () => number;
  reply?: (call: Call, n: number) => Response;
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return opts.reply ? opts.reply(call, calls.length) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const pool = new KeyPool(opts.keys, opts.now);
  const tenant: Tenant = { id: "co", token: TOKEN, pool, virtualModels: () => opts.virtual, router: opts.router ? () => opts.router : undefined, resolveKey: async (k) => `secret-${k.id}` };
  const server = createGatewayServer({ fetchImpl, tenants: () => [tenant] });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { post, calls, pool, base };
}

describe("local rate budgets", () => {
  it("skips a key over its rpm and answers 429 with Retry-After when none is left", async () => {
    let now = 1_000_000;
    const { post, calls } = await start({ keys: [{ id: "a", provider: "groq", limits: { rpm: 1 } }], virtual: { f: ["groq/m"] }, now: () => now });
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200);
    const blocked = await post("/v1/chat/completions", { model: "f", messages: [] });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(1); // no upstream call was wasted
    now += 61_000;
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200);
  });

  it("moves on to the next provider when the first is over its daily budget", async () => {
    const { post, calls } = await start({
      keys: [{ id: "a", provider: "github", limits: { rpd: 1 } }, { id: "b", provider: "groq" }],
      virtual: { f: ["github/x", "groq/y"] },
    });
    await post("/v1/chat/completions", { model: "f", messages: [] });
    await post("/v1/chat/completions", { model: "f", messages: [] });
    expect(calls.map((c) => c.url)).toEqual([
      "https://models.github.ai/inference/chat/completions",
      "https://api.groq.com/openai/v1/chat/completions",
    ]);
  });

  it("counts tokens from non-streamed answers against tpd", async () => {
    const { post, pool } = await start({ keys: [{ id: "a", provider: "groq", limits: { tpd: 15 } }], virtual: { f: ["groq/m"] } });
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200); // 10 tokens
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200); // 20 >= 15
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(429);
    expect(pool.snapshot()[0].tokensToday).toBe(20);
  });
});

describe("persistent quota", () => {
  it("restores same-day counters and ignores yesterday's", () => {
    const day1 = Date.UTC(2026, 9, 11, 10);
    const a = new KeyPool([{ id: "k", provider: "groq", limits: { rpd: 2 } }], () => day1);
    a.recordRequest("k"); a.recordRequest("k"); a.recordTokens("k", 7); a.reportAuthFailure("k");
    const saved = JSON.parse(JSON.stringify(a.exportState()));

    const same = new KeyPool([{ id: "k", provider: "groq", limits: { rpd: 2 } }], () => day1 + 3_600_000);
    same.importState(saved);
    expect(same.snapshot()[0]).toMatchObject({ requestsToday: 2, tokensToday: 7, disabled: true });

    const next = new KeyPool([{ id: "k", provider: "groq", limits: { rpd: 2 } }], () => day1 + 86_400_000);
    next.importState(saved);
    expect(next.snapshot()[0]).toMatchObject({ requestsToday: 0, tokensToday: 0, disabled: false });
  });

  it("re-enables keys after an operator saves the config", () => {
    const pool = new KeyPool([{ id: "k", provider: "groq" }]);
    pool.reportAuthFailure("k");
    expect(pool.candidates("groq")).toHaveLength(0);
    pool.clearDisabled();
    expect(pool.candidates("groq")).toHaveLength(1);
  });
});

describe("embeddings", () => {
  it("forwards /v1/embeddings through the same failover", async () => {
    const { post, calls } = await start({
      keys: [{ id: "a", provider: "mistral" }, { id: "b", provider: "gemini" }],
      virtual: { embed: ["mistral/mistral-embed", "gemini/gemini-embedding-001"] },
      reply: (_c, n) => (n === 1 ? new Response("{}", { status: 429 }) : new Response('{"data":[{"embedding":[0.1]}],"usage":{"total_tokens":3}}', { status: 200, headers: { "content-type": "application/json" } })),
    });
    const res = await post("/v1/embeddings", { model: "embed", input: "hi" });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.mistral.ai/v1/embeddings",
      "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
    ]);
    expect(calls[1].body.model).toBe("gemini-embedding-001");
  });
});

describe("auto router", () => {
  const router: RouterConfig = { model: "groq/small", descriptions: { "free-fast": "short answers", "free-smart": "hard reasoning and long code" } };
  const keys = [{ id: "a", provider: "groq" }, { id: "b", provider: "gemini" }];
  const virtual = { "free-fast": ["groq/fast"], "free-smart": ["gemini/smart"] };
  const answer = (name: string) => new Response(JSON.stringify({ choices: [{ message: { content: name } }] }), { status: 200, headers: { "content-type": "application/json" } });

  it("lets the router model choose and reports the choice", async () => {
    const { post, calls } = await start({ keys, virtual, router, reply: (c) => (c.body.model === "small" ? answer("free-smart") : answer("done")) });
    const res = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "prove this theorem" }] });
    expect(res.headers.get("x-gateway-routed-model")).toBe("free-smart");
    expect(calls.map((c) => c.body.model)).toEqual(["small", "smart"]);
    const question = JSON.stringify(calls[0].body.messages);
    expect(question).toContain("hard reasoning and long code");
    expect(question).toContain("prove this theorem");
  });

  it("falls back to the first candidate when the router fails or answers nonsense", async () => {
    const { post } = await start({ keys, virtual, router, reply: (c) => (c.body.model === "small" ? answer("banana") : answer("done")) });
    const res = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] });
    expect(res.headers.get("x-gateway-routed-model")).toBe("free-fast");
  });

  it("is only offered when a router is configured", async () => {
    const without = await start({ keys, virtual });
    expect((await post404(without)).status).toBe(404);
    const withRouter = await start({ keys, virtual, router });
    const list = await (await fetch(`${withRouter.base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(list.data.map((m: { id: string }) => m.id)).toContain("auto");
  });
});

function post404(s: { post: (p: string, b: unknown) => Promise<Response> }) {
  return s.post("/v1/chat/completions", { model: "auto", messages: [] });
}

describe("credit-based providers", () => {
  it("treats 402 like an exhausted quota and fails over", async () => {
    const { post, calls, pool } = await start({
      keys: [{ id: "hf", provider: "huggingface" }, { id: "g", provider: "groq" }],
      virtual: { f: ["huggingface/Qwen/Qwen3-32B:cerebras", "groq/y"] },
      reply: (_c, n) => (n === 1 ? new Response('{"error":"credits depleted"}', { status: 402 }) : new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } })),
    });
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200);
    expect(calls[0].url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(calls[0].body.model).toBe("Qwen/Qwen3-32B:cerebras");
    expect(pool.candidates("huggingface")).toHaveLength(0); // paused, not disabled
    expect(pool.snapshot()[0].disabled).toBe(false);
  });
});

describe("free-only guard", () => {
  it("refuses a paid model named directly, without calling the provider", async () => {
    const { post, calls } = await start({ keys: [{ id: "r", provider: "requesty" }], virtual: {} });
    const blocked = await post("/v1/chat/completions", { model: "requesty/openai/gpt-4o", messages: [] });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.type).toBe("paid_model_blocked");
    expect(calls).toHaveLength(0);
    const free = await post("/v1/chat/completions", { model: "requesty/nvidia/nemotron-3-super-120b-a12b", messages: [] });
    expect(free.status).toBe(200);
    expect(calls[0].url).toBe("https://router.requesty.ai/v1/chat/completions");
    expect(calls[0].body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
  });

  it("drops paid targets from a chain but keeps the free ones", async () => {
    const { post, calls } = await start({ keys: [{ id: "r", provider: "requesty" }, { id: "g", provider: "groq" }], virtual: { f: ["requesty/openai/gpt-4o", "groq/m"] } });
    expect((await post("/v1/chat/completions", { model: "f", messages: [] })).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
  });
});
