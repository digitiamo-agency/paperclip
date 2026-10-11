/** Local per-key budgets. A missing or zero value means unlimited. */
export interface Limits {
  /** Requests per rolling minute. */
  rpm?: number;
  /** Requests per UTC day. */
  rpd?: number;
  /** Tokens per UTC day, counted from non-streamed responses that report usage. */
  tpd?: number;
}

export interface PoolKey {
  id: string;
  provider: string;
  /** Cloudflare account id (not secret); part of the upstream URL. */
  accountId?: string;
  limits?: Limits;
}

interface KeyState {
  cooldownUntil: number;
  disabled: boolean;
  consecutiveFailures: number;
  requests: number;
  rateLimited: number;
  /** Timestamps of attempts in the last minute. */
  minuteHits: number[];
  day: string;
  requestsToday: number;
  tokensToday: number;
}

export interface KeySnapshot extends PoolKey {
  disabled: boolean;
  cooldownUntil: number;
  requests: number;
  rateLimited: number;
  requestsToday: number;
  tokensToday: number;
}

/** What survives a worker restart: daily counters and penalties, never secrets. */
export interface PoolState {
  day: string;
  keys: Record<string, { requestsToday: number; tokensToday: number; cooldownUntil: number; disabled: boolean }>;
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const SERVER_ERROR_COOLDOWN_MS = 10_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const MINUTE_MS = 60_000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const msUntilNextDay = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ms;
};

/**
 * Per-key health and budgets. Keys rotate round robin and are skipped while
 * cooling down, disabled, or over a local limit.
 */
export class KeyPool {
  private readonly state = new Map<string, KeyState>();
  private readonly cursor = new Map<string, number>();

  constructor(
    private keys: PoolKey[],
    private readonly now: () => number = Date.now,
  ) {
    this.setKeys(keys);
  }

  /** Replace the key list, keeping health for keys that remain configured. */
  setKeys(keys: PoolKey[]): void {
    this.keys = keys;
    const ids = new Set(keys.map((k) => k.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
    for (const k of keys) {
      if (!this.state.has(k.id)) {
        this.state.set(k.id, {
          cooldownUntil: 0, disabled: false, consecutiveFailures: 0, requests: 0, rateLimited: 0,
          minuteHits: [], day: dayOf(this.now()), requestsToday: 0, tokensToday: 0,
        });
      }
    }
  }

  private rollover(s: KeyState, now: number): void {
    const today = dayOf(now);
    if (s.day !== today) {
      s.day = today;
      s.requestsToday = 0;
      s.tokensToday = 0;
    }
    while (s.minuteHits.length && s.minuteHits[0] <= now - MINUTE_MS) s.minuteHits.shift();
  }

  /** Milliseconds until a local limit frees this key, or 0 when it is within budget. */
  private limitWait(k: PoolKey, s: KeyState, now: number): number {
    this.rollover(s, now);
    const l = k.limits ?? {};
    let wait = 0;
    if (l.rpm && s.minuteHits.length >= l.rpm) wait = Math.max(wait, s.minuteHits[0] + MINUTE_MS - now);
    if ((l.rpd && s.requestsToday >= l.rpd) || (l.tpd && s.tokensToday >= l.tpd)) wait = Math.max(wait, msUntilNextDay(now));
    return wait;
  }

  /** Healthy keys for a provider, ordered starting after the last one handed out. */
  candidates(provider: string): PoolKey[] {
    const now = this.now();
    const usable = this.keys.filter((k) => {
      const s = this.state.get(k.id)!;
      return k.provider === provider && !s.disabled && s.cooldownUntil <= now && this.limitWait(k, s, now) === 0;
    });
    if (usable.length === 0) return [];
    const start = (this.cursor.get(provider) ?? 0) % usable.length;
    this.cursor.set(provider, start + 1);
    return [...usable.slice(start), ...usable.slice(0, start)];
  }

  /** Shortest wait until any key of the provider is usable again; undefined if none can recover. */
  retryAfterMs(provider: string): number | undefined {
    const now = this.now();
    let best: number | undefined;
    for (const k of this.keys) {
      const s = this.state.get(k.id)!;
      if (k.provider !== provider || s.disabled) continue;
      const wait = Math.max(s.cooldownUntil - now, this.limitWait(k, s, now), 0);
      if (best === undefined || wait < best) best = wait;
    }
    return best;
  }

  /** Count an attempt against the local request budgets, before it is sent. */
  recordRequest(id: string): void {
    const s = this.state.get(id);
    if (!s) return;
    const now = this.now();
    this.rollover(s, now);
    s.requests += 1;
    s.requestsToday += 1;
    s.minuteHits.push(now);
  }

  recordTokens(id: string, tokens: number): void {
    const s = this.state.get(id);
    if (!s || !Number.isFinite(tokens) || tokens <= 0) return;
    this.rollover(s, this.now());
    s.tokensToday += tokens;
  }

  reportSuccess(id: string): void {
    const s = this.state.get(id);
    if (s) s.consecutiveFailures = 0;
  }

  reportRateLimited(id: string, retryAfterMs?: number): void {
    const s = this.state.get(id);
    if (!s) return;
    s.rateLimited += 1;
    s.cooldownUntil = this.now() + Math.min(retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  }

  reportAuthFailure(id: string): void {
    const s = this.state.get(id);
    if (s) s.disabled = true;
  }

  /** Re-enable keys switched off by an authentication error, e.g. after the operator replaced the key. */
  clearDisabled(): void {
    for (const s of this.state.values()) s.disabled = false;
  }

  reportServerError(id: string): void {
    const s = this.state.get(id);
    if (!s) return;
    s.consecutiveFailures += 1;
    const backoff = SERVER_ERROR_COOLDOWN_MS * 2 ** Math.min(s.consecutiveFailures - 1, 5);
    s.cooldownUntil = this.now() + Math.min(backoff, MAX_COOLDOWN_MS);
  }

  snapshot(): KeySnapshot[] {
    const now = this.now();
    return this.keys.map((k) => {
      const s = this.state.get(k.id)!;
      this.rollover(s, now);
      return {
        ...k, disabled: s.disabled, cooldownUntil: s.cooldownUntil, requests: s.requests,
        rateLimited: s.rateLimited, requestsToday: s.requestsToday, tokensToday: s.tokensToday,
      };
    });
  }

  exportState(): PoolState {
    const now = this.now();
    const keys: PoolState["keys"] = {};
    for (const k of this.keys) {
      const s = this.state.get(k.id)!;
      this.rollover(s, now);
      keys[k.id] = { requestsToday: s.requestsToday, tokensToday: s.tokensToday, cooldownUntil: s.cooldownUntil, disabled: s.disabled };
    }
    return { day: dayOf(now), keys };
  }

  /** Restore counters saved earlier the same UTC day; older state is ignored. */
  importState(saved: unknown): void {
    if (!saved || typeof saved !== "object") return;
    const { day, keys } = saved as Partial<PoolState>;
    const now = this.now();
    if (day !== dayOf(now) || !keys || typeof keys !== "object") return;
    for (const [id, v] of Object.entries(keys)) {
      const s = this.state.get(id);
      if (!s || !v || typeof v !== "object") continue;
      const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
      s.requestsToday = num(v.requestsToday);
      s.tokensToday = num(v.tokensToday);
      s.cooldownUntil = Math.min(num(v.cooldownUntil), now + MAX_COOLDOWN_MS);
      s.disabled = v.disabled === true;
    }
  }
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
