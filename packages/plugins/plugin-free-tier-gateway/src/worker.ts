import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { configErrors, parseConfig } from "./config.js";
import { KeyPool } from "./pool.js";
import { createGatewayServer, type RouterConfig, type Tenant } from "./proxy.js";

/**
 * The host allows only 30 `secrets.resolve` calls per minute per company and plugin,
 * far below what an agent harness issues. Resolved values are therefore kept in
 * memory (never persisted or logged) for a short time, and dropped on any config
 * save or authentication failure so a rotated key recovers.
 */
const SECRET_TTL_MS = 5 * 60_000;

/** Workers get a minimal env, so the port is fixed; the next ports are tried if it is taken. */
const BASE_PORT = 4000;
const PORT_ATTEMPTS = 10;

interface CompanyTenant extends Tenant {
  virtualMap: Record<string, string[]>;
  routerConfig?: RouterConfig;
  paidAllowed: boolean;
  dirty: boolean;
  secretRefs: Map<string, { ref: unknown; configPath: string }>;
  secretCache: Map<string, { value: string; expires: number }>;
}

/**
 * Created at module load, i.e. outside any host invocation. The SDK tags every
 * worker->host call with the AsyncLocalStorage invocation of its caller, and a
 * socket inherits the context that was active when it started listening. A
 * server started inside `onConfigChanged` would therefore send an expired
 * invocation id with each request and be denied `secrets.resolve`. Listening
 * from this resource gives requests no invocation, so the host authorizes them
 * through the plugin's configured-company (proactive) scope instead.
 */
const detached = new AsyncResource("free-tier-gateway-listener");

const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let stateWarned = false;

const tenants = new Map<string, CompanyTenant>();
let server: Server | null = null;
let baseUrl = "";
let startup: Promise<void> | null = null;
let ctxRef: PluginContext | null = null;

async function companyToken(ctx: PluginContext, companyId: string): Promise<string> {
  const key = { scopeKind: "company", scopeId: companyId, stateKey: "gateway-token" } as const;
  const existing = await ctx.state.get(key);
  if (typeof existing === "string" && existing) return existing;
  const token = `pcgw_${randomBytes(24).toString("hex")}`;
  await ctx.state.set(key, token);
  return token;
}

async function listen(created: Server): Promise<number> {
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = BASE_PORT + i;
    const ok = await new Promise<boolean>((resolve, reject) => {
      created.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
      detached.runInAsyncScope(() => created.listen(port, "127.0.0.1", () => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error(`No free port in ${BASE_PORT}-${BASE_PORT + PORT_ATTEMPTS - 1}`);
}

const usageKey = (companyId: string) => ({ scopeKind: "company", scopeId: companyId, stateKey: "usage" }) as const;

/** Persist daily counters so a restart does not forget what was already spent. */
async function flushUsage(ctx: PluginContext, onlyDirty: boolean): Promise<void> {
  for (const [companyId, tenant] of tenants) {
    if (onlyDirty && !tenant.dirty) continue;
    tenant.dirty = false;
    try {
      await ctx.state.set(usageKey(companyId), tenant.pool.exportState());
    } catch (err) {
      tenant.dirty = true;
      if (!stateWarned) {
        stateWarned = true;
        ctx.logger.warn(`free-tier gateway could not persist usage: ${(err as Error).message}`);
      }
    }
  }
}

function ensureServer(ctx: PluginContext): Promise<void> {
  startup ??= (async () => {
    const created = createGatewayServer({
      tenants: () => tenants.values(),
      onEvent: (e) => {
        if (e.tenant) { const t = tenants.get(e.tenant); if (t) t.dirty = true; }
        if (e.type === "key_disabled" && e.tenant) tenants.get(e.tenant)?.secretCache.delete(e.keyId ?? "");
        if (e.type === "upstream_error") ctx.logger.warn(`free-tier gateway: ${e.provider} returned ${e.status}${e.detail ? ` (${e.detail})` : ""} for key ${e.keyId}`);
        if (e.type === "key_disabled") ctx.logger.warn(`free-tier gateway disabled key ${e.keyId} after an authentication error`);
      },
    });
    const port = await listen(created);
    server = created;
    // Timers inherit the async context they are created in, so start it detached like the listener.
    flushTimer ??= detached.runInAsyncScope(() => setInterval(() => void flushUsage(ctx, true), FLUSH_INTERVAL_MS));
    flushTimer.unref();
    baseUrl = `http://127.0.0.1:${port}/v1`;
    ctx.logger.info(`free-tier gateway listening on ${baseUrl}`);
  })().catch((err) => {
    startup = null;
    throw err;
  });
  return startup;
}

async function stop(): Promise<void> {
  const current = server;
  server = null;
  startup = null;
  if (current) await new Promise<void>((resolve) => { current.close(() => resolve()); current.closeAllConnections(); });
}

async function applyCompany(ctx: PluginContext, companyId: string, raw: Record<string, unknown>): Promise<void> {
  const next = parseConfig(raw);
  const errors = configErrors(next);
  if (errors.length) {
    ctx.logger.warn(`free-tier gateway config for company ${companyId} invalid: ${errors.join("; ")}`);
    return;
  }
  const keys = next.keys.map(({ id, provider, accountId, limits }) => ({ id, provider, accountId, limits }));
  const existing = tenants.get(companyId);
  if (existing) {
    existing.pool.setKeys(keys);
    existing.virtualMap = next.virtualModels;
    existing.secretRefs = new Map(next.keys.map((k) => [k.id, { ref: k.apiKey, configPath: k.configPath }]));
    existing.secretCache.clear();
    existing.routerConfig = next.router;
    existing.paidAllowed = next.allowPaidModels;
    existing.pool.clearDisabled();
  } else {
    const tenant: CompanyTenant = {
      id: companyId,
      token: await companyToken(ctx, companyId),
      pool: new KeyPool(keys),
      virtualMap: next.virtualModels,
      secretRefs: new Map(next.keys.map((k) => [k.id, { ref: k.apiKey, configPath: k.configPath }])),
      secretCache: new Map(),
      dirty: false,
      routerConfig: next.router,
      paidAllowed: next.allowPaidModels,
      allowPaidModels: () => tenant.paidAllowed,
      router: () => tenant.routerConfig,
      virtualModels: () => tenant.virtualMap,
      // Resolved per request through the host's company scope; never cached here.
      resolveKey: async (key) => {
        const cached = tenant.secretCache.get(key.id);
        if (cached && cached.expires > Date.now()) return cached.value;
        const entry = tenant.secretRefs.get(key.id);
        if (!entry) throw new Error(`No secret configured for ${key.id}`);
        const value = await ctx.secrets.resolve(entry.ref as never, { companyId, configPath: entry.configPath });
        tenant.secretCache.set(key.id, { value, expires: Date.now() + SECRET_TTL_MS });
        return value;
      },
    };
    try {
      tenant.pool.importState(await ctx.state.get(usageKey(companyId)));
    } catch {
      // No saved usage yet, or state unavailable: start from zero.
    }
    tenants.set(companyId, tenant);
  }
  await ensureServer(ctx);
}

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    ctxRef = ctx;
    ctx.data.register("status", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const tenant = tenants.get(companyId);
      return {
        listening: server !== null,
        configured: tenant !== undefined,
        baseUrl,
        token: tenant?.token ?? "",
        virtualModels: Object.keys(tenant?.virtualMap ?? {}),
        keys: (tenant?.pool.snapshot() ?? []).map((k) => ({
          id: k.id,
          provider: k.provider,
          disabled: k.disabled,
          coolingDown: k.cooldownUntil > Date.now(),
          requests: k.requests,
          rateLimited: k.rateLimited,
          requestsToday: k.requestsToday,
          tokensToday: k.tokensToday,
          limits: k.limits ?? {},
        })),
        auto: tenant?.routerConfig ? { model: tenant.routerConfig.model, candidates: Object.keys(tenant.routerConfig.descriptions) } : null,
      };
    });
  },

  async onConfigChanged(newConfig, context) {
    // Setup cannot read config: it is company-scoped and arrives here, also on startup replay.
    const companyId = context?.companyId;
    if (!companyId || !ctxRef) return;
    await applyCompany(ctxRef, companyId, newConfig);
  },

  async onValidateConfig(raw) {
    const errors = configErrors(parseConfig(raw));
    return { ok: errors.length === 0, errors };
  },

  async onHealth() {
    if (!server) return { status: "ok", message: "Waiting for a company to configure keys" };
    return { status: "ok", message: `Listening on ${baseUrl}; ${tenants.size} company tenant(s)` };
  },

  // A listening socket can receive work at any time, so never report idle.
  async onIdleDrain() {
    return server ? "present" : "none";
  },

  async onShutdown() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (ctxRef) await flushUsage(ctxRef, false);
    await stop();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
