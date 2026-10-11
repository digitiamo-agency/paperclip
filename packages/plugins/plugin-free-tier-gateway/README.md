# @paperclipai/plugin-free-tier-gateway

Local OpenAI-compatible gateway that pools **official free-tier API keys**
(see the table below) with rate-limit rotation
and provider failover. Design: `doc/plans/2026-10-11-free-tier-llm-gateway-plugin.md`.

Status: core proxy plus a read-only dashboard widget (URL, token, key health). Keys come from the plugin's instance
config as secret refs and are resolved per request, never cached.

## Providers

| Provider id | Endpoint | Free key |
| --- | --- | --- |
| `gemini` | generativelanguage.googleapis.com (OpenAI-compat) | aistudio.google.com/apikey |
| `groq` | api.groq.com/openai/v1 | console.groq.com/keys |
| `cerebras` | api.cerebras.ai/v1 | cloud.cerebras.ai |
| `mistral` | api.mistral.ai/v1 | console.mistral.ai/api-keys |
| `nvidia` | integrate.api.nvidia.com/v1 | build.nvidia.com |
| `github` | models.github.ai/inference | github.com/settings/tokens |
| `openrouter` | openrouter.ai/api/v1 | openrouter.ai/settings/keys |
| `huggingface` | router.huggingface.co/v1 | huggingface.co/settings/tokens (permission: "Make calls to Inference Providers") |
| `plugsky` | plugsky.com/v1 | plugsky.com (free plan: `plugsky-micro`, `plugsky-lite`) |
| `requesty` | router.requesty.ai/v1 | app.requesty.ai (free models: 200 requests/day, 20/minute per organization) |
| `cloudflare` | api.cloudflare.com/.../accounts/{accountId}/ai/v1 | dash.cloudflare.com/profile/api-tokens (needs `accountId`) |

`huggingface` routes to third-party providers and is **credit-based**, not
quota-based: free accounts get a small monthly credit, and an empty balance answers
`402` ("no remaining credits"). The gateway treats `402` like an exhausted quota
(the key pauses and the next target is tried). Model ids may end in `:provider`
to pin a backend, e.g. `huggingface/Qwen/Qwen3-32B:cerebras`.

`plugsky` is a smaller, newer service. Its free plan offers two models and
"limited API access" with no published numbers, so there is no local budget and its
limits surface as `429`. Its marketing claims (customers, volumes, "unlimited") are
unverified; read its privacy terms before sending it prompts you care about.

**Free-only guard.** Some gateways mix free and billed models. By default this
plugin refuses targets known to be billed: OpenRouter ids without `:free`, and any
Requesty model outside its published free list (`src/providers.ts`, checked
2026-10-11, "free for now"). The check runs when the config is saved and on every
request, so a client cannot reach a paid model by naming it directly (`403
paid_model_blocked`, no provider call). Set `allowPaidModels` to lift it. Hugging
Face is credit-based as a whole and is not filtered; every call there spends credit.

Model names change often (Gemini 2.5 Flash is already retired for new users), so
list a provider's current models with its own `/models` endpoint before mapping
a virtual model. Targets are `provider/model`, split on the first slash.

## Behaviour

- One server on `127.0.0.1:4000` (next free port up to 4009). Every request
  except `/healthz` needs `Authorization: Bearer <token>`. Each company has its
  own token (generated on first config save, kept in company plugin state), key
  pool and virtual models, so tokens never cross companies.
- Keys live in slots `key1`..`key12` of the company's plugin config, each with a
  `provider`, optional `label` and an `apiKey` secret reference. Slots, not a
  list, because the host tracks secret refs only on nested object properties.
- Secrets are resolved through the host's configured-company scope and kept in
  worker memory for 5 minutes (the host allows only 30 resolutions per minute per
  company), never persisted or logged. The cache is dropped on config save and
  on a `401/403` from the provider. The listener is opened from a module-level
  `AsyncResource` so requests carry no stale invocation id (see `src/worker.ts`).
- `POST /v1/chat/completions` (streaming and non-streaming) and `GET /v1/models`.
- `model` is a virtual name (`free-fast`) or a direct `provider/model`.
- `429` cools the key down (honours `Retry-After`) and tries the next key, then
  the next target. `401/403` disables the key. `5xx`/network errors back off.
  Other `4xx` are returned unchanged. Failover stops once a response starts.

## Budgets, embeddings, persistence, `auto`

- **Local budgets.** Each key has requests/minute, requests/day and tokens/day
  budgets (conservative provider defaults in `src/providers.ts`; override per key
  with `rpm`, `rpd`, `tpd`, `0` switches one off). A key over budget is skipped
  before any upstream call, and a refusal carries `Retry-After`. Token counts come
  from non-streamed answers that report `usage`; streamed ones are not counted.
- **Embeddings.** `POST /v1/embeddings` uses the same virtual models, keys and
  failover. Map a virtual model such as `free-embed` to a provider's embedding
  model (verified: `cloudflare/@cf/baai/bge-base-en-v1.5`, 768 dimensions).
- **Persistent quota.** Daily counters, cooldowns and disabled keys are saved in
  company plugin state every 30 seconds and on shutdown, and restored the same UTC
  day. Saving the plugin config re-enables keys that had been switched off.
- **`auto`.** Set `routerModel` (a small, fast virtual model or `provider/model`)
  and `routerDescriptions` (virtual model -> what it is good at) and the gateway
  offers an `auto` model. One extra request asks the router model which candidate
  fits the prompt; the answer is reported in the `x-gateway-routed-model` header,
  and any failure falls back to the first described model. The router sees an
  excerpt of the last user message, so it must be a provider you already trust
  with prompts.

## Connect it to an agent

Add a native **Chat Completions API** connection with the base URL shown in
the dashboard widget (`http://127.0.0.1:4000/v1`) and the company token as the key.

The manifest declares `network.listen.loopback`, which is informational: workers
are plain Node processes, so the host cannot enforce it.

## Not done yet

- Usage metrics and quota tracking beyond in-memory counters.
- Keys and virtual models are edited in the host's auto-generated plugin
  settings form; a custom settings page would replace that form.
- Idle sleep: the worker reports `present` while listening, so it blocks
  automatic idle sleep until a safe drain is defined.
- Live end-to-end proof with a successful completion through a Paperclip
  instance: secret resolution is verified, but the free Gemini quota ran out first.

## Develop

```sh
pnpm --filter @paperclipai/plugin-free-tier-gateway test
pnpm --filter @paperclipai/plugin-free-tier-gateway typecheck
```
