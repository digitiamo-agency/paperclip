import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPool } from "../src/pool.js";
import { createGatewayServer } from "../src/proxy.js";

const TOKEN = "local-token";
const servers: ReturnType<typeof createGatewayServer>[] = [];

type Reply = { status: number; body?: string; headers?: Record<string, string> };

async function start(replies: Record<string, Reply[]>, virtual: Record<string, string[]>, keys: { id: string; provider: string }[], extra: { hangOn?: string; upstreamTimeoutMs?: number } = {}) {
  const calls: { url: string; auth: string; model: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    calls.push({ url, auth, model: JSON.parse(String(init.body)).model });
    if (extra.hangOn === auth.slice(7)) {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const next = replies[auth.slice(7)]?.shift() ?? { status: 200, body: "{}" };
    return new Response(next.body ?? "{}", { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  const pool = new KeyPool(keys);
  const server = createGatewayServer({
    fetchImpl, upstreamTimeoutMs: extra.upstreamTimeoutMs,
    tenants: () => [{ id: "co-1", token: TOKEN, pool, virtualModels: () => virtual, resolveKey: async (k) => `secret-${k.id}` }],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (model: string, token = TOKEN) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });
  return { base, post, calls, pool };
}

afterEach(() => { while (servers.length) servers.pop()!.close(); });

describe("gateway proxy", () => {
  it("rejects requests without the local token", async () => {
    const { post } = await start({}, { fast: ["groq/m"] }, [{ id: "a", provider: "groq" }]);
    expect((await post("fast", "wrong")).status).toBe(401);
  });

  it("rotates to the next key on 429 and cools the first one down", async () => {
    const { post, calls, pool } = await start(
      { "secret-a": [{ status: 429, headers: { "retry-after": "30" } }], "secret-b": [{ status: 200, body: '{"ok":1}' }] },
      { fast: ["groq/llama"] },
      [{ id: "a", provider: "groq" }, { id: "b", provider: "groq" }],
    );
    const res = await post("fast");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer secret-a", "Bearer secret-b"]);
    expect(calls[1].model).toBe("llama");
    expect(pool.candidates("groq").map((k) => k.id)).toEqual(["b"]);
  });

  it("disables a key on 401 and fails over to the next provider", async () => {
    const { post, calls, pool } = await start(
      { "secret-a": [{ status: 401 }], "secret-c": [{ status: 200, body: '{"from":"cerebras"}' }] },
      { smart: ["groq/x", "cerebras/y"] },
      [{ id: "a", provider: "groq" }, { id: "c", provider: "cerebras" }],
    );
    const res = await post("smart");
    expect(await res.json()).toEqual({ from: "cerebras" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.groq.com/openai/v1/chat/completions",
      "https://api.cerebras.ai/v1/chat/completions",
    ]);
    expect(pool.snapshot().find((k) => k.id === "a")!.disabled).toBe(true);
  });

  it("returns 429 when every key is exhausted", async () => {
    const { post } = await start({ "secret-a": [{ status: 429 }] }, { fast: ["groq/m"] }, [{ id: "a", provider: "groq" }]);
    expect((await post("fast")).status).toBe(429);
  });

  it("passes client errors through without failover", async () => {
    const { post, calls } = await start(
      { "secret-a": [{ status: 400, body: '{"error":"bad"}' }] },
      { fast: ["groq/m"] },
      [{ id: "a", provider: "groq" }, { id: "b", provider: "groq" }],
    );
    expect((await post("fast")).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("accepts direct provider/model names and lists virtual models", async () => {
    const { post, base } = await start({}, { fast: ["groq/m"] }, [{ id: "a", provider: "groq" }]);
    expect((await post("groq/llama")).status).toBe(200);
    expect((await post("nope")).status).toBe(404);
    const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(["fast"]);
  });

  it("fails over when an upstream never answers", async () => {
    const { post, calls } = await start(
      { "secret-b": [{ status: 200, body: '{"ok":2}' }] },
      { fast: ["groq/m"] },
      [{ id: "a", provider: "groq" }, { id: "b", provider: "groq" }],
      { hangOn: "secret-a", upstreamTimeoutMs: 50 },
    );
    const res = await post("fast");
    expect(await res.json()).toEqual({ ok: 2 });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer secret-a", "Bearer secret-b"]);
  });

  it("keeps tenants isolated by token", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).authorization);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const mk = (id: string, token: string) => ({
      id, token,
      pool: new KeyPool([{ id: `${id}-key`, provider: "groq" }]),
      virtualModels: () => ({ fast: ["groq/m"] }),
      resolveKey: async () => `secret-of-${id}`,
    });
    const tenants = [mk("a", "token-a"), mk("b", "token-b")];
    const server = createGatewayServer({ fetchImpl, tenants: () => tenants });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (token: string) => fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fast", messages: [] }),
    });
    expect((await call("token-b")).status).toBe(200);
    expect((await call("token-a")).status).toBe(200);
    expect((await call("token-c")).status).toBe(401);
    expect(seen).toEqual(["Bearer secret-of-b", "Bearer secret-of-a"]);
    expect(tenants[0].pool.snapshot()[0].requests).toBe(1);
  });

  it("moves to the next target, not the next key, when a request is too large", async () => {
    const { post, calls } = await start(
      { "secret-a": [{ status: 413 }], "secret-c": [{ status: 200, body: '{"ok":3}' }] },
      { big: ["groq/small", "cerebras/large"] },
      [{ id: "a", provider: "groq" }, { id: "b", provider: "groq" }, { id: "c", provider: "cerebras" }],
    );
    const res = await post("big");
    expect(await res.json()).toEqual({ ok: 3 });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer secret-a", "Bearer secret-c"]);
  });

  it("retries once within a model's max_tokens limit", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return n++ === 0
        ? new Response('{"error":{"message":"`max_tokens` must be less than or equal to `16384`"}}', { status: 400 })
        : new Response('{"ok":4}', { status: 200 });
    }) as unknown as typeof fetch;
    const server = createGatewayServer({
      fetchImpl,
      tenants: () => [{ id: "t", token: TOKEN, pool: new KeyPool([{ id: "a", provider: "groq" }]), virtualModels: () => ({ q: ["groq/qwen"] }), resolveKey: async () => "s" }],
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "q", max_tokens: 32000, messages: [{ role: "assistant", content: "x", reasoning_content: "secret thoughts" }] }),
    });
    expect(await res.json()).toEqual({ ok: 4 });
    expect(bodies.map((b) => b.max_tokens)).toEqual([32000, 16384]);
    expect(JSON.stringify(bodies[0])).not.toContain("reasoning_content");
  });

  it("builds the per-account Cloudflare URL and skips keys without a valid account id", async () => {
    const ACCOUNT = "0123456789abcdef0123456789abcdef";
    const { post, calls } = await start(
      { "secret-ok": [{ status: 200, body: '{"ok":5}' }] },
      { cf: ["cloudflare/@cf/openai/gpt-oss-120b"] },
      [{ id: "bad", provider: "cloudflare" }, { id: "ok", provider: "cloudflare", accountId: ACCOUNT }],
    );
    const res = await post("cf");
    expect(await res.json()).toEqual({ ok: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1/chat/completions`);
    expect(calls[0].model).toBe("@cf/openai/gpt-oss-120b");
  });
});
