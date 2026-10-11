# Free-tier LLM gateway plugin

Status: implemented in `packages/plugins/plugin-free-tier-gateway` (see its README for current behaviour). The "Outcome" section at the end records where the build departed from this plan. Source idea: pool official free-tier API keys behind one local OpenAI-compatible gateway.

## Goal

A first-party plugin, `paperclip.free-tier-gateway`, that runs a local
OpenAI-compatible proxy which pools **official free-tier API keys** (Gemini,
Groq, Cerebras, GitHub Models, OpenRouter `:free`, ...) with rate-limit aware
rotation and cross-provider failover. Agents consume it through the existing
native **Chat Completions API** gateway connection; no core adapter changes.

Out of scope: reusing consumer subscription logins (ChatGPT/Claude/Gemini web)
through a proxy. Those stay on the native login flows (`claude_local`,
`codex_local`). Only credentials issued by a provider for API use are accepted.

## What core already gives us

- `kind: "gateway"` AI connections with an OpenAI-compatible `baseUrl`, loopback
  HTTP allowed, plus model discovery from `/models`
  (`packages/shared/src/ai-provider-routing.ts`, `server/src/routes/ai-connections.ts`).
  The `chat` protocol is compatible with `opencode_local` and `hermes_local`.
- Plugin secrets via `secrets.read-ref`, per-instance settings
  (`instance.settings.register`), plugin state, jobs, and `http.outbound`.

## Constraints that shape the design

1. Plugin API routes (`/api/plugins/:id/api/*`) are JSON-only, so they cannot
   serve `stream: true` completions. The proxy therefore listens on its own
   loopback port from the worker (`node:http`). No existing plugin does this;
   it needs a host review and probably a new declared capability
   (working name `network.listen.loopback`).
2. The `ai.connections.route` router contract never exposes credentials and only
   picks among existing accounts, so it cannot implement this. Not used.
3. Idle sleep: a worker that holds a listening socket must implement
   `onIdleDrain` and report `present` while requests are in flight.
4. Keys are secrets. Store them as Paperclip secret refs, never in plugin
   state or logs. Bind to `127.0.0.1` only and require a generated local bearer
   token so other local processes cannot spend the pool.

## Components

- `src/manifest.ts`: capabilities `http.outbound`, `secrets.read-ref`,
  `plugin.state.read/write`, `jobs.schedule`, `instance.settings.register`,
  `ui.page.register`.
- `src/proxy/server.ts`: `/v1/chat/completions` (stream and non-stream),
  `/v1/models`, `/healthz`.
- `src/providers/*`: one small adapter per provider (base URL, auth header,
  model-id mapping, error classification). Most are OpenAI-compatible
  pass-through; Gemini uses its OpenAI-compat endpoint.
- `src/pool/`: key pool with per-key, per-model state (cooldown until,
  requests/minute and per-day counters, consecutive failures). A `429` honours
  `Retry-After`; `401/403` disables the key and surfaces it in the UI; `5xx`
  and timeouts fail over.
- `src/routing/`: virtual model names (`free-fast`, `free-smart`, `free-code`)
  mapped to an ordered list of `provider/model`. Failover is only attempted
  before the first streamed byte; after that the error is returned.
- `src/ui/`: settings page (add keys, test key, virtual-model mapping, copy
  base URL) and a dashboard widget (requests, 429 rate, remaining quota).
- Metrics via `metrics.write` and an activity entry on key disable.

## Phases

1. **Spike**: confirm the host allows a loopback listener from a worker, and
   what capability it should require. Decide on `network.listen.loopback`.
2. **Core proxy**: one provider (Groq), non-streaming, pool of N keys, tests
   with a fake upstream.
3. **Streaming and failover**: SSE pass-through, cooldown logic, multi-provider.
4. **UI and secrets**: settings page, secret refs, local bearer token.
5. **Docs and registration**: README, `doc/plugins` entry, onboarding hint to
   add the gateway connection pointing at the printed base URL.

## Open questions

- Should the plugin create the native gateway connection automatically, or only
  print the URL and token? Plugins have no capability to create AI connections
  today; automatic creation would need a core API.
- Per-company pools versus one instance-wide pool. Core rule 1 says
  company-scoped; the proxy is a shared local process, so keys and usage must
  be keyed by company at least in state, and the bearer token issued per company.

## Verification

- Unit tests with `@paperclipai/plugin-sdk/testing` and a fake upstream for
  429 rotation, 401 disable, failover, and stream interruption.
- `pnpm --filter <plugin> typecheck && pnpm test`, then the full check from
  AGENTS.md section 7 before a PR.
- Live proof: one real free-tier key through an `opencode_local` agent.

## Outcome and deviations

Built and verified against a live local instance (Gemini, Groq, OpenRouter, Cloudflare,
Plugsky, Requesty, Hugging Face). Where reality differed from the plan above:

- **Config and secrets are per company.** The host delivers plugin config through
  `onConfigChanged(config, { companyId })` and rejects `config.get` from `setup`. The
  gateway is therefore multi-tenant: one pool, token and model map per company, one
  shared loopback server (port 4000, next free port up to 4009).
- **The listener must start outside any host invocation.** The SDK tags worker-to-host
  calls with the AsyncLocalStorage invocation of the caller, and a socket inherits the
  context active when it starts listening. The server and its timers are started from a
  module-level `AsyncResource` so requests carry no stale invocation id.
- **Secrets are cached for 5 minutes in worker memory.** The host allows 30
  `secrets.resolve` calls per minute per company and plugin. The cache is never
  persisted or logged, and is dropped on config save and on a provider 401/403.
- **Keys are fixed slots (`key1`..`key12`), not a list**, because the host tracks secret
  references only on nested object properties.
- **`network.listen.loopback`** was added as a declarative capability.
- **Additions beyond the plan:** per-key local budgets (rpm/rpd/tpd), persistent daily
  counters, `/v1/embeddings`, the `auto` router, upstream header timeout, `413` moves to
  the next target, `max_tokens` clamp retry, `reasoning_content` stripping for Groq, `402`
  treated as exhausted credit, and a free-only guard against billed models.
- **Not done:** Hugging Face and Plugsky were not verified with a successful completion
  (no credits / intermittent 503); a custom settings page (it would replace the
  auto-generated form); idle-sleep drain (the worker reports `present` while listening).
- **Known limit of free tiers:** an agent harness sends roughly 9k tokens of prompt, which
  exceeds Groq's free per-minute token budget. OpenRouter and Cloudflare models passed the
  OpenCode harness test; an agent task ran end to end through the gateway (file created, comments posted; the free model did not close the issue).

