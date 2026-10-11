import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { KeyPool, parseRetryAfter, type PoolKey } from "./pool.js";
import { isFreeTarget, normalizeBody, parseTarget, parseTokenLimit, upstreamBaseUrl, type Target } from "./providers.js";

/** Name of the virtual model that lets a small LLM pick the real one. */
export const AUTO_MODEL = "auto";

export interface RouterConfig {
  /** Virtual model or `provider/model` used for the routing question. */
  model: string;
  /** Virtual model name -> what it is good at. Only described models are candidates. */
  descriptions: Record<string, string>;
}

/** One company's view of the gateway: its own token, key pool and model map. */
export interface Tenant {
  id: string;
  /** Bearer token required from local clients of this tenant. */
  token: string;
  pool: KeyPool;
  /** Virtual model name -> ordered `provider/model` targets. */
  virtualModels: () => Record<string, string[]>;
  /** When true, targets known to be paid are allowed. Defaults to free-only. */
  allowPaidModels?: () => boolean;
  /** Optional prompt-aware routing behind the `auto` model. */
  router?: () => RouterConfig | undefined;
  /** Resolve a key's secret; callers may cache it briefly but must never persist it. */
  resolveKey: (key: PoolKey) => Promise<string>;
}

export type GatewayEvent = {
  tenant?: string;
  type: "served" | "rate_limited" | "key_disabled" | "upstream_error" | "exhausted" | "routed";
  provider?: string;
  keyId?: string;
  status?: number;
  detail?: string;
};

export interface GatewayOptions {
  tenants: () => Iterable<Tenant>;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  /** How long to wait for upstream response headers before failing over. */
  upstreamTimeoutMs?: number;
  onEvent?: (event: GatewayEvent) => void;
}

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const ROUTER_TIMEOUT_MS = 8_000;
const ROUTER_EXCERPT_CHARS = 1_500;

type Outcome =
  | { ok: true; upstream: Response; target: Target; key: PoolKey }
  | { ok: false; status: number; message: string; retryAfterMs?: number; clientGone?: boolean };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function apiError(res: ServerResponse, status: number, message: string, type = "gateway_error", headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type } }, headers);
}

/** Match the bearer token against every tenant without an early exit. */
function authenticate(req: IncomingMessage, tenants: Iterable<Tenant>): Tenant | null {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  let match: Tenant | null = null;
  for (const t of tenants) {
    const want = Buffer.from(t.token);
    if (given.length === want.length && timingSafeEqual(given, want)) match = t;
  }
  return match;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function targetsFor(model: string, virtual: Record<string, string[]>): Target[] {
  const names = virtual[model] ?? [model];
  return names.map(parseTarget).filter((t): t is Target => t !== null);
}

/** Plain text of the last user message, whether `content` is a string or a list of parts. */
function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join(" ");
    }
  }
  return "";
}

/** Create the loopback HTTP server. The caller owns listen() and close(). */
export function createGatewayServer(opts: GatewayOptions): Server {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const headerTimeout = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  /** Try every key of every target in order; the first usable answer wins. */
  async function forward(
    tenant: Tenant,
    path: string,
    body: Record<string, unknown>,
    targets: Target[],
    clientGone: AbortSignal,
    timeoutMs: number,
  ): Promise<Outcome> {
    let lastStatus = 0;

    for (const target of targets) {
      for (const key of tenant.pool.candidates(target.provider)) {
        const baseUrl = upstreamBaseUrl(target.provider, key.accountId);
        if (!baseUrl) continue;
        let upstream: Response;
        // One signal per attempt: client disconnect aborts it, and so does a
        // silent upstream. The timer covers headers only, never the streamed body.
        const attempt = new AbortController();
        const onClientGone = () => attempt.abort();
        clientGone.addEventListener("abort", onClientGone, { once: true });
        const timer = setTimeout(() => attempt.abort(), timeoutMs);
        try {
          const secret = await tenant.resolveKey(key);
          const send = (payload: Record<string, unknown>) => {
            tenant.pool.recordRequest(key.id);
            return doFetch(`${baseUrl}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
              body: JSON.stringify(payload),
              signal: attempt.signal,
            });
          };
          const payload = normalizeBody(target.provider, { ...body, model: target.model });
          upstream = await send(payload);
          if (upstream.status === 400) {
            // Some models cap max_tokens below what agent harnesses ask for. Read the
            // limit from the error and retry once instead of failing the whole turn.
            const text = await upstream.text();
            const limit = parseTokenLimit(text);
            const asked = Number(payload.max_tokens ?? payload.max_completion_tokens ?? Infinity);
            if (limit !== null && asked > limit) {
              const field = "max_completion_tokens" in payload ? "max_completion_tokens" : "max_tokens";
              upstream = await send({ ...payload, [field]: limit });
            } else {
              upstream = new Response(text, { status: 400, headers: upstream.headers });
            }
          }
        } catch (err) {
          if (clientGone.aborted) return { ok: false, status: 499, message: "Client closed the request", clientGone: true };
          const cause = (err as { cause?: { code?: string } }).cause?.code;
          const detail = attempt.signal.aborted ? "timeout" : `${(err as Error).name}${cause ? ` ${cause}` : ""}: ${String((err as Error).message).slice(0, 160)}`;
          tenant.pool.reportServerError(key.id);
          lastStatus = 504;
          opts.onEvent?.({ tenant: tenant.id, type: "upstream_error", provider: target.provider, keyId: key.id, status: 504, detail });
          continue;
        } finally {
          clearTimeout(timer);
          clientGone.removeEventListener("abort", onClientGone);
        }

        if (upstream.status === 429 || upstream.status === 402) {
          // 402 means a credit-based account (Hugging Face) ran dry: same handling as a quota 429.
          tenant.pool.reportRateLimited(key.id, parseRetryAfter(upstream.headers.get("retry-after")));
          opts.onEvent?.({ tenant: tenant.id, type: "rate_limited", provider: target.provider, keyId: key.id });
          lastStatus = 429;
          await upstream.body?.cancel();
          continue;
        }
        if (upstream.status === 401 || upstream.status === 403) {
          tenant.pool.reportAuthFailure(key.id);
          opts.onEvent?.({ tenant: tenant.id, type: "key_disabled", provider: target.provider, keyId: key.id });
          lastStatus = upstream.status;
          await upstream.body?.cancel();
          continue;
        }
        if (upstream.status === 413) {
          // Too large for this model's context or per-minute token budget. Another
          // key will not help, but a different target (model/provider) might.
          lastStatus = 413;
          await upstream.body?.cancel();
          break;
        }
        if (upstream.status >= 500) {
          tenant.pool.reportServerError(key.id);
          opts.onEvent?.({ tenant: tenant.id, type: "upstream_error", provider: target.provider, keyId: key.id, status: upstream.status });
          lastStatus = upstream.status;
          await upstream.body?.cancel();
          continue;
        }

        // 2xx and other 4xx are final. Failover is only possible before this point,
        // i.e. before the first byte of a stream reaches the client.
        if (upstream.ok) tenant.pool.reportSuccess(key.id);
        opts.onEvent?.({ tenant: tenant.id, type: "served", provider: target.provider, keyId: key.id });
        return { ok: true, upstream, target, key };
      }
    }

    opts.onEvent?.({ tenant: tenant.id, type: "exhausted" });
    if (lastStatus === 413) return { ok: false, status: 413, message: "The request is too large for every configured model" };
    const waits = targets.map((t) => tenant.pool.retryAfterMs(t.provider)).filter((w): w is number => w !== undefined);
    const retryAfterMs = waits.length ? Math.min(...waits) : undefined;
    const limited = lastStatus === 429 || lastStatus === 0;
    return {
      ok: false,
      status: limited ? 429 : 502,
      message: lastStatus === 0
        ? "Every key is over its local rate budget or cooling down; retry later"
        : "All free-tier keys are exhausted or unavailable; retry later",
      retryAfterMs,
    };
  }

  /** Ask the router model which candidate fits the request; falls back to the first candidate. */
  async function routeAuto(tenant: Tenant, router: RouterConfig, body: Record<string, unknown>, clientGone: AbortSignal): Promise<string | null> {
    const virtual = tenant.virtualModels();
    const candidates = Object.keys(router.descriptions).filter((n) => n !== AUTO_MODEL && virtual[n]);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const chars = JSON.stringify(body.messages ?? "").length;
    const usesTools = Array.isArray(body.tools) && body.tools.length > 0;
    const targets = targetsFor(router.model, virtual);
    const question: Record<string, unknown> = {
      model: router.model,
      stream: false,
      max_tokens: 24,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You route requests to the best model. Reply with exactly one option name and nothing else.",
            "Options:",
            ...candidates.map((n) => `- ${n}: ${router.descriptions[n]}`),
          ].join("\n"),
        },
        {
          role: "user",
          content: `Request size: about ${chars} characters${usesTools ? "; the caller uses tools" : ""}.\nUser message:\n${lastUserText(body.messages).slice(0, ROUTER_EXCERPT_CHARS)}`,
        },
      ],
    };
    const outcome = await forward(tenant, "/chat/completions", question, targets, clientGone, Math.min(headerTimeout, ROUTER_TIMEOUT_MS));
    if (!outcome.ok) return candidates[0];
    try {
      const reply = String(((await outcome.upstream.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "").toLowerCase();
      const exact = candidates.find((n) => reply.trim() === n.toLowerCase());
      if (exact) return exact;
      // Prefer the longest name found inside the reply so `free-fast` does not shadow `free-fast-2`.
      const found = candidates.filter((n) => reply.includes(n.toLowerCase())).sort((a, b) => b.length - a.length)[0];
      return found ?? candidates[0];
    } catch {
      return candidates[0];
    }
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, tenant: Tenant, path: "/chat/completions" | "/embeddings"): Promise<void> {
    const raw = await readBody(req, maxBody);
    if (!raw) return apiError(res, 413, "Request body too large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return apiError(res, 400, "Body must be valid JSON", "invalid_request_error");
    }
    if (typeof body.model !== "string") return apiError(res, 400, "`model` is required", "invalid_request_error");

    const clientGone = new AbortController();
    res.on("close", () => { if (!res.writableEnded) clientGone.abort(); });

    let model = body.model;
    const extraHeaders: Record<string, string> = {};
    const router = tenant.router?.();
    if (path === "/chat/completions" && model === AUTO_MODEL && router) {
      const picked = await routeAuto(tenant, router, body, clientGone.signal);
      if (clientGone.signal.aborted) return;
      if (!picked) return apiError(res, 400, "`auto` needs at least one described virtual model in the router settings", "invalid_request_error");
      opts.onEvent?.({ tenant: tenant.id, type: "routed", detail: picked });
      extraHeaders["x-gateway-routed-model"] = picked;
      model = picked;
    }

    const allTargets = targetsFor(model, tenant.virtualModels());
    if (allTargets.length === 0) return apiError(res, 404, `Unknown model \`${model}\``, "invalid_request_error");
    const targets = tenant.allowPaidModels?.() ? allTargets : allTargets.filter((t) => isFreeTarget(t.provider, t.model));
    if (targets.length === 0) {
      return apiError(res, 403, `\`${model}\` is not a free model; this gateway only calls free models unless paid models are enabled`, "paid_model_blocked");
    }

    const outcome = await forward(tenant, path, body, targets, clientGone.signal, headerTimeout);
    if (!outcome.ok) {
      if (outcome.clientGone) return;
      const headers: Record<string, string> = { ...extraHeaders };
      if (outcome.status === 429 && outcome.retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)));
      return apiError(res, outcome.status, outcome.message, outcome.status === 413 ? "request_too_large" : "rate_limit_exceeded", headers);
    }

    const { upstream, key } = outcome;
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    const streamed = body.stream === true;
    if (upstream.ok && !streamed && contentType.includes("json")) {
      // Small JSON answer: read it to count tokens against the key's daily budget.
      const text = await upstream.text();
      try {
        tenant.pool.recordTokens(key.id, Number((JSON.parse(text) as { usage?: { total_tokens?: number } }).usage?.total_tokens));
      } catch {
        // Not JSON after all; forward as is.
      }
      res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-cache", ...extraHeaders });
      return void res.end(text);
    }
    res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-cache", ...extraHeaders });
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as never).on("error", () => res.destroy()).pipe(res);
  }

  function models(res: ServerResponse, tenant: Tenant): void {
    const ids = new Set(Object.keys(tenant.virtualModels()));
    if (tenant.router?.()) ids.add(AUTO_MODEL);
    sendJson(res, 200, { object: "list", data: [...ids].map((id) => ({ id, object: "model", owned_by: "paperclip-free-tier-gateway" })) });
  }

  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    const tenant = authenticate(req, opts.tenants());
    if (!tenant) return apiError(res, 401, "Invalid gateway token", "authentication_error");
    const run = req.method === "POST" && path === "/v1/chat/completions" ? proxy(req, res, tenant, "/chat/completions")
      : req.method === "POST" && path === "/v1/embeddings" ? proxy(req, res, tenant, "/embeddings")
      : req.method === "GET" && path === "/v1/models" ? Promise.resolve(models(res, tenant))
      : Promise.resolve(apiError(res, 404, "Not found"));
    run.catch(() => { if (!res.headersSent) apiError(res, 500, "Internal gateway error"); else res.destroy(); });
  });
}
