import type { Limits, PoolKey } from "./pool.js";
import { isFreeTarget, isValidAccountId, parseTarget, PROVIDERS } from "./providers.js";
import type { RouterConfig } from "./proxy.js";

/**
 * The host tracks secret references only on nested object properties, never
 * inside arrays, so keys are fixed slots rather than a list.
 */
export const KEY_SLOTS = Array.from({ length: 12 }, (_, i) => `key${i + 1}`);

export interface ConfiguredKey extends PoolKey {
  /** Secret reference as stored in the company's plugin config. */
  apiKey: unknown;
  /** Dot path of `apiKey` inside the config, passed to `secrets.resolve`. */
  configPath: string;
}

export interface GatewayConfig {
  keys: ConfiguredKey[];
  virtualModels: Record<string, string[]>;
  /** Set when `routerModel` and at least one description are configured. */
  router?: RouterConfig;
  /** Permit targets known to be billed. Off by default: this gateway is for free tiers. */
  allowPaidModels: boolean;
}

export function parseConfig(raw: Record<string, unknown>): GatewayConfig {
  const keys: ConfiguredKey[] = [];
  for (const slot of KEY_SLOTS) {
    const entry = raw[slot];
    if (!entry || typeof entry !== "object") continue;
    const { provider, label, apiKey, accountId, rpm, rpd, tpd } = entry as Record<string, unknown>;
    if (typeof provider !== "string" || !apiKey) continue;
    // Provider defaults, overridden per key; 0 switches a budget off.
    const limits: Limits = { ...(PROVIDERS[provider]?.limits ?? {}) };
    for (const [name, value] of [["rpm", rpm], ["rpd", rpd], ["tpd", tpd]] as const) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) limits[name] = value;
    }
    keys.push({
      limits,
      id: `${provider}:${typeof label === "string" && label ? label : slot}`,
      provider,
      ...(typeof accountId === "string" && accountId.trim() ? { accountId: accountId.trim() } : {}),
      apiKey,
      configPath: `${slot}.apiKey`,
    });
  }
  const virtualModels: Record<string, string[]> = {};
  const vm = raw.virtualModels;
  if (vm && typeof vm === "object") {
    for (const [name, list] of Object.entries(vm)) {
      if (Array.isArray(list)) virtualModels[name] = list.filter((t): t is string => typeof t === "string");
    }
  }
  let router: RouterConfig | undefined;
  const desc = raw.routerDescriptions;
  if (typeof raw.routerModel === "string" && raw.routerModel.trim() && desc && typeof desc === "object") {
    const descriptions = Object.fromEntries(Object.entries(desc).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));
    if (Object.keys(descriptions).length) router = { model: raw.routerModel.trim(), descriptions };
  }
  return { keys, virtualModels, allowPaidModels: raw.allowPaidModels === true, ...(router ? { router } : {}) };
}

/** Human-readable problems, used by `onValidateConfig`. */
export function configErrors(cfg: GatewayConfig): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const k of cfg.keys) {
    if (ids.has(k.id)) errors.push(`duplicate key label: ${k.id}`);
    ids.add(k.id);
    if (PROVIDERS[k.provider]?.baseUrl.includes("{accountId}") && !isValidAccountId(k.accountId)) {
      errors.push(`${k.id}: ${k.provider} needs a 32-character hexadecimal accountId`);
    }
  }
  for (const [name, targets] of Object.entries(cfg.virtualModels)) {
    for (const t of targets) {
      const parsed = parseTarget(t);
      if (!parsed) errors.push(`virtual model "${name}": unknown target "${t}"`);
      else if (!cfg.allowPaidModels && !isFreeTarget(parsed.provider, parsed.model)) {
        errors.push(`virtual model "${name}": "${t}" is not a known free model (set allowPaidModels to use it)`);
      }
    }
  }
  if (cfg.router) {
    const m = cfg.router.model;
    if (m === "auto") errors.push('routerModel cannot be "auto"');
    else if (!cfg.virtualModels[m] && !parseTarget(m)) errors.push(`routerModel "${m}" is neither a virtual model nor a provider/model target`);
    for (const name of Object.keys(cfg.router.descriptions)) {
      if (!cfg.virtualModels[name]) errors.push(`routerDescriptions: unknown virtual model "${name}"`);
    }
  }
  return errors;
}
