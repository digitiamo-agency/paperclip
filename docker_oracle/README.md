# Paperclip → Oracle Container Registry (OCIR)

Build e publish dell'immagine Docker **Paperclip** (fork Digitiamo) su Oracle Container Registry.

Usa il `Dockerfile` in root del monorepo (target `production` di default). Il build context è la root del repo; Docker legge `.dockerignore` dalla root.

## Prerequisiti

- Docker con BuildKit **e buildx** (Docker Desktop abilita QEMU per cross-build arm64/amd64)
- Node / pnpm (solo se non usi `--skip-typecheck`)
- Repository creato in OCI → Developer Services → Container Registry (es. `digitiamo/paperclip`)
- Auth Token OCI (Profile → Auth Tokens) per `docker login`
- Checkout completo del fork Paperclip

## Multi-arch (amd64 + arm64)

`publish.sh` pubblica di default un **manifest list** per:

- `linux/amd64`
- `linux/arm64`

Così lo stesso tag (es. `latest`) funziona su VM x86 e su host ARM (Apple Silicon, Ampere OCI, ecc.).

Override:

```bash
# solo amd64 (più veloce in debug)
DOCKER_PLATFORMS=linux/amd64 ./docker_oracle/publish.sh --skip-typecheck

# solo arm64
DOCKER_PLATFORMS=linux/arm64 ./docker_oracle/publish.sh --skip-typecheck
```

Verifica dopo il push:

```bash
docker buildx imagetools inspect lin.ocir.io/<namespace>/<repo>:<tag>
```

`build.sh` locale resta sulla piattaforma nativa dell'host (con `--load`). Per una prova multi-arch senza push: `./docker_oracle/publish.sh --skip-push`.

## Setup credenziali

```bash
cp docker_oracle/.env.example docker_oracle/.env
# modifica OCIR_REGION, OCIR_NAMESPACE, OCIR_REPO, OCIR_USERNAME, OCIR_PASSWORD
```

`docker_oracle/.env` non va committato (copre il pattern `.env` in `.gitignore`).

## Build locale

```bash
./docker_oracle/build.sh
```

Tag personalizzato:

```bash
IMAGE_TAG=0.3.1 ./docker_oracle/build.sh
```

Target cloud (plugin sandbox bundled):

```bash
DOCKER_TARGET=cloud ./docker_oracle/build.sh
```

La build locale usa buildx sulla piattaforma host. Il publish multi-arch va fatto con `publish.sh`.

## Pubblicazione su OCIR

```bash
./docker_oracle/publish.sh
# oppure
./docker_oracle/build-push-ocir.sh
```

Build lunga: salta il typecheck se hai già verificato in CI/locale:

```bash
./docker_oracle/publish.sh --skip-typecheck
```

Il publish multi-arch **builda una piattaforma alla volta** (poi unisce i manifest), per evitare OOM su Docker Desktop quando QEMU emula l’altra arch in parallelo.

Consigli se vedi `cannot allocate memory` / `ResourceExhausted` / exit `137`:

1. Su **Apple Silicon** pubblichi nativo con `DOCKER_PLATFORMS=linux/arm64` — lo script usa `docker build` (non il builder container buildx), che consuma meno RAM.
2. In Docker Desktop → Settings → Resources alza la RAM (idealmente ≥ 8–12 GB). Prima di ritentare: `docker builder prune -f`
3. La build `linux/amd64` su Mac ARM è QEMU: falla solo se ti serve davvero, meglio su CI/host x86.
4. Opzionale: `NODE_MAX_OLD_SPACE_SIZE=2048` se il `tsc` del server va ancora in OOM.

Restano anche tag intermedi per-arch (es. `0.3.1-<sha>-linux-arm64`) usati per assemblare il manifest list.

### Versioning

| Tag | Esempio | Quando |
|-----|---------|--------|
| Principale (immutabile) | `0.3.1-a1b2c3d` | Sempre: `server/package.json` version + git short sha |
| Semver | `0.3.1` | Se `PUSH_SEMVER=true` (default) |
| Latest | `latest` | Se `PUSH_LATEST=true` (default) |

Sovrascrittura manuale: `./docker_oracle/publish.sh --version 0.3.1-beta1`

Solo build/tag senza push: `./docker_oracle/publish.sh --skip-push`

Anteprima comandi: `./docker_oracle/publish.sh --dry-run`

Login manuale (alternativa a `OCIR_USERNAME` / `OCIR_PASSWORD`):

```bash
# host da regione: eu-frankfurt-1 → fra.ocir.io, eu-milan-1 → lin.ocir.io
docker login lin.ocir.io \
  -u '<OCIR_NAMESPACE>/<oci-username>' \
  -p '<auth-token>'
```

Host per regione: mappatura in `docker_oracle/lib/common.sh` (Milano usa **lin.ocir.io**).

### Errore `Unauthorized` su login

1. **Password** = **Auth Token** generato in OCI (Profile → Auth Tokens), non la password web.
2. **OCIR_USERNAME** = `<namespace>/<utente>` dello **stesso** utente per cui hai creato il token.
3. Permessi IAM sull'utente/gruppo per Container Registry nel compartment del repository.
4. Token non scaduto/revocato; rigenera se necessario.

Formato immagine remota:

```text
<region-host>.ocir.io/<tenancy-namespace>/digitiamo/paperclip:<tag>
```

## Esecuzione (Docker Compose)

**Non** includere secret nell'immagine. Le variabili Paperclip stanno in `paperclip.env` (separato da `.env` OCIR).

```bash
cp docker_oracle/paperclip.env.example docker_oracle/paperclip.env
# genera secret:
#   openssl rand -hex 32   → BETTER_AUTH_SECRET e PAPERCLIP_TOOL_ACTION_SIGNING_SECRET
# imposta PAPERCLIP_PUBLIC_URL (e opzionalmente API key LLM)

# Login OCIR se usi l'immagine remota
docker login lin.ocir.io -u '<namespace>/<user>' -p '<auth-token>'

docker compose -f docker_oracle/docker-compose.yml \
  --env-file docker_oracle/paperclip.env up -d
```

DB embedded (default): lascia `DATABASE_URL` vuoto; i dati restano in `PAPERCLIP_DATA_DIR`.

Postgres dedicato:

```bash
# in paperclip.env:
# DATABASE_URL=postgres://paperclip:paperclip@db:5432/paperclip

docker compose -f docker_oracle/docker-compose.yml \
  --env-file docker_oracle/paperclip.env --profile db up -d
```

Build locale al posto del pull:

```bash
docker compose -f docker_oracle/docker-compose.yml \
  --env-file docker_oracle/paperclip.env up -d --build
```

Dettagli runtime: [`docs/deploy/docker.md`](../docs/deploy/docker.md).

## File

| File | Ruolo |
|------|--------|
| `build.sh` | Build locale buildx (piattaforma host, `--load`) |
| `publish.sh` | Pipeline: typecheck → buildx multi-arch → push OCIR |
| `build-push-ocir.sh` | Alias di `publish.sh` |
| `lib/common.sh` | Versioning, OCIR, helper buildx/piattaforme |
| `.env.example` | Variabili OCIR (solo per publish) |
| `paperclip.env.example` | Variabili runtime Paperclip (compose) |
| `docker-compose.yml` | Run da OCIR / build locale (+ profilo `db`) |

Il Dockerfile e l'entrypoint di runtime restano in root (`Dockerfile`, `scripts/docker-entrypoint.sh`).
