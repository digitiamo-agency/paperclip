# Esecuzione locale — Fork Digitiamo Paperclip

Guida operativa per avviare la piattaforma in locale dal clone del fork Digitiamo.

Documentazione correlata: [fork e sync upstream](./digitiamo-fork.md) · [runtime agenti](./agents-runtime.md) · guida upstream [DEVELOPING.md](../doc/DEVELOPING.md)

## Prerequisiti

| Requisito | Versione / note |
|-----------|-----------------|
| Node.js | **≥ 24.11** (`package.json` → `engines.node`) |
| pnpm | **9.15.4** (campo `packageManager`; `corepack enable` consigliato) |
| Git | Clone del fork già configurato con `origin` + `upstream` |
| Rust (opzionale) | Necessario se abiliti la build del Paperclip Runner nativo; in alternativa imposta `PAPERCLIP_RUNNER_BINARY` su un binario precompilato |
| Python 3 (opzionale) | Utile per sign-in subscription locali Claude/Codex |
| CLI provider (opzionale) | `claude`, `codex`, `opencode`, … già installate e autenticate sull’host se usi adapter `*_local` |

Database esterno **non** obbligatorio in dev: di default parte un **PostgreSQL embedded**.

Checkout tipico:

```text
/Users/massimiliano.andreatta/PROJECTS/PAPERCLIP
```

## Avvio rapido (sviluppo da sorgente)

Percorso consigliato sul fork Digitiamo:

```bash
cd /Users/massimiliano.andreatta/PROJECTS/PAPERCLIP

# una tantum
corepack enable
pnpm install

# avvio API + UI (watch)
pnpm dev
```

Poi apri: **http://localhost:3100**

- API e UI condividono la stessa origin in dev.
- `pnpm dev` è idempotente: se il runner è già attivo, non ne avvia un secondo.

### Alternativa CLI dal repo

```bash
pnpm paperclipai run
```

Se manca la config, fa onboard, health-check con auto-repair e avvia il server.

### Onboard / configure

```bash
# setup iniziale (dal repo)
pnpm paperclipai onboard --yes

# modifica impostazioni in seguito
pnpm paperclipai configure
```

Rieseguire `onboard` conserva config e path dati esistenti.

## Comandi utili

| Comando | Cosa fa |
|---------|---------|
| `pnpm dev` | Dev completo (API + UI, watch) |
| `pnpm dev:once` | Dev senza watch; applica migrazioni locali pendenti |
| `pnpm dev:server` | Solo server |
| `pnpm dev:ui` | Solo UI package |
| `pnpm dev:mobile` | UI prebuilt su **:3101**, proxy `/api` → **:3100** (telefono/tablet) |
| `pnpm dev:both` | `dev` + `dev:mobile` insieme |
| `pnpm dev:list` | Elenca servizi/dev runner |
| `pnpm dev:stop` | Ferma il dev runner |
| `pnpm build` | Build workspace |
| `pnpm typecheck` | Typecheck |
| `pnpm test` | Suite Vitest “cheap” (no Playwright) |
| `pnpm db:migrate` | Applica migrazioni DB |
| `pnpm db:generate` | Genera migrazioni |

Stop tipico:

```bash
pnpm dev:stop
# oppure
./scripts/kill-dev.sh
```

## Dati e percorsi locali

Stato di default (istanza `default`):

```text
~/.paperclip/instances/default/
  config.json
  db/                 # Postgres embedded
  data/storage/       # file / allegati
  data/backups/
  secrets/master.key
  workspaces/
  plugins/
```

### Istanza isolata (consigliato per esperimenti)

```bash
pnpm dev --data-dir ./tmp/paperclip-dev

# stessi flag per list/stop
pnpm dev:list --data-dir ./tmp/paperclip-dev
pnpm dev:stop --data-dir ./tmp/paperclip-dev
```

`--data-dir` imposta un `PAPERCLIP_HOME` isolato (DB embedded, storage, registry servizi).

### Reset DB embedded (distruttivo)

```bash
# ferma prima il processo
pnpm dev:stop
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

Usa solo su dati di sviluppo che puoi perdere.

## Variabili d’ambiente

Per override avanzati esiste [`.env.example`](../.env.example) in root. In modalità embedded tipica **non** serve copiarlo.

Esempi rilevanti:

| Variabile | Uso |
|-----------|-----|
| `PORT` | Porta HTTP (default `3100`) |
| `DATABASE_URL` | Postgres esterno (se non usi embedded) |
| `PAPERCLIP_RUNNER_BINARY` | Path a runner nativo precompilato |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … | Credenziali provider per adapter locali / Docker |
| `PAPERCLIP_PUBLIC_URL` / `BETTER_AUTH_URL` | Origin pubblica (OAuth / accessi non-loopback) |

Non committare file `.env` con secret.

## Postgres esterno (opzionale)

Se preferisci un Postgres dedicato invece dell’embedded:

1. Avvia Postgres (locale o Docker) con un database dedicato.
2. Imposta `DATABASE_URL` (vedi `.env.example`).
3. Configura la sezione database:

```bash
pnpm paperclipai configure --section database
pnpm db:migrate
pnpm dev
```

## Docker (senza Node locale)

Dal root del repo:

```bash
docker compose -f docker/docker-compose.quickstart.yml up --build
```

- UI/API: http://localhost:3100  
- Dati: `./data/docker-paperclip` (override con `PAPERCLIP_DATA_DIR`, `PAPERCLIP_PORT`)

Dettagli: [`docs/deploy/docker.md`](./deploy/docker.md).

Per adapter locali nel container, passa le API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) come env del container.

## Accesso da LAN / Tailscale

Il quickstart da sorgente è in **trusted local / loopback**. Per bind su rete:

```bash
pnpm paperclipai onboard --yes --bind lan
# oppure
pnpm paperclipai onboard --yes --bind tailnet
```

Per mobile sulla stessa rete, `pnpm dev:both` e apri `http://<host>:3101`.

## Dopo l’avvio — checklist operativa

1. Apri http://localhost:3100  
2. Crea la prima company e un goal  
3. Crea un agente CEO e scegli l’adapter  
4. Verifica che la CLI/provider sia installata e autenticata (per `*_local`)  
5. Usa **Test environment** nella config agente prima di salvare  
6. Assegna task / abilita heartbeat e monitora costi  

Runtime agenti (heartbeat, adapter, timeout): [`docs/agents-runtime.md`](./agents-runtime.md).

## Troubleshooting

| Problema | Cosa fare |
|----------|-----------|
| Node troppo vecchio | Installa Node ≥ 24.11; verifica con `node -v` |
| `pnpm` assente / versione sbagliata | `corepack enable` poi `corepack prepare pnpm@9.15.4 --activate` |
| Porta 3100 occupata | `pnpm dev:list` / `pnpm dev:stop`, oppure cambia `PORT` |
| Doppio processo / stato confuso | `pnpm dev:stop` e rilancia `pnpm dev` |
| Migrazioni pendenti | `pnpm db:migrate` o `pnpm dev:once` |
| Adapter local fallisce | CLI provider mancante/non loggata; API key assente; vedi log run nell’UI |
| Runner nativo non compila | Installa Rust toolchain oppure imposta `PAPERCLIP_RUNNER_BINARY` |
| `npx paperclipai` 404 (registry privato) | `npx --registry https://registry.npmjs.org paperclipai@latest …` — sul fork preferisci `pnpm paperclipai` |

## Percorsi a confronto

| Scenario | Comando |
|----------|---------|
| Sviluppo sul fork Digitiamo | `pnpm install` → `pnpm dev` |
| Smoke isolato senza toccare `~/.paperclip` | `pnpm dev --data-dir ./tmp/paperclip-dev` |
| Install “prodotto” da npm (non dal fork) | `npx paperclipai@latest onboard --yes` |
| Container | `docker compose -f docker/docker-compose.quickstart.yml up --build` |

## Riferimenti

| Risorsa | Path / URL |
|---------|------------|
| Questo documento | `docs/digitiamo-local.md` |
| Fork / sync | `docs/digitiamo-fork.md` |
| Dev guide upstream | `doc/DEVELOPING.md` |
| Quickstart docs | `docs/start/quickstart.md` |
| Docker | `docs/deploy/docker.md` |
| Env example | `.env.example` |
