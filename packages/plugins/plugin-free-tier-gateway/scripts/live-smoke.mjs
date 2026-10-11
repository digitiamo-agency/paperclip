// Live proof against the real Gemini OpenAI-compatible endpoint.
// Usage: GEMINI_API_KEY=... [GEMINI_MODEL=gemini-2.5-flash] node scripts/live-smoke.mjs
// The key is read from the environment only; it is never printed or written.
import { KeyPool } from "../dist/pool.js";
import { createGatewayServer } from "../dist/proxy.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Set GEMINI_API_KEY in the environment.");
  process.exit(2);
}
const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const token = "smoke-token";
const pool = new KeyPool([{ id: "gemini:smoke", provider: "gemini" }]);
const server = createGatewayServer({
  tenants: () => [{ id: "smoke", token, pool, virtualModels: () => ({ "free-fast": [`gemini/${model}`] }), resolveKey: async () => apiKey }],
  onEvent: (e) => { if (e.type !== "served") console.log(`  event: ${e.type}${e.status ? ` ${e.status}` : ""}${e.detail ? ` (${e.detail})` : ""}`); },
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
};

const req = (stream) => fetch(`${base}/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model: "free-fast", stream, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
});

const t0 = Date.now();
const plain = await req(false);
console.log(`  plain took ${Date.now() - t0}ms`);
const plainBody = await plain.json().catch(() => ({}));
check("non-streaming completion", plain.status === 200 && Boolean(plainBody.choices?.[0]?.message?.content),
  plain.status === 200 ? `reply: ${String(plainBody.choices[0].message.content).slice(0, 40)}` : `status ${plain.status} ${JSON.stringify(plainBody).slice(0, 200)}`);

const sse = await req(true);
const text = await sse.text();
check("streaming completion", sse.status === 200 && text.includes("data:") && text.includes("[DONE]"),
  `status ${sse.status}, ${text.split("\n\n").length - 1} events`);

const bad = await fetch(`${base}/chat/completions`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: "{}" });
check("rejects wrong gateway token", bad.status === 401);

const snap = pool.snapshot()[0];
check("pool counted the requests", snap.requests >= 2 && !snap.disabled, `requests=${snap.requests} disabled=${snap.disabled}`);

server.close();
process.exit(failed ? 1 : 0);
