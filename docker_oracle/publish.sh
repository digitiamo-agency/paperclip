#!/usr/bin/env bash
#
# Pipeline: typecheck opzionale → buildx multi-arch → push OCIR (manifest list).
#
# Versioning (default):
#   - tag principale: <semver>-<gitSha>   es. 0.3.1-a1b2c3d
#   - tag aggiuntivo semver: <semver>     es. 0.3.1  (PUSH_SEMVER=true)
#   - tag latest                        (PUSH_LATEST=true)
#
# Piattaforme (default): linux/amd64,linux/arm64
# Override: DOCKER_PLATFORMS=linux/amd64  oppure  linux/arm64
#
# Configurazione: docker_oracle/.env (copia da docker_oracle/.env.example)
#
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${DOCKER_DIR}/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=lib/common.sh
source "${DOCKER_DIR}/lib/common.sh"

SKIP_TYPECHECK=false
SKIP_PUSH=false
SKIP_LOGIN=false
SKIP_BUILD=false
DRY_RUN=false
VERSION_OVERRIDE=""

usage() {
  cat <<'EOF'
Uso: ./docker_oracle/publish.sh [opzioni]

Esegue typecheck (opzionale), build Docker Paperclip multi-arch (amd64+arm64)
e push su Oracle Container Registry (OCIR) come manifest list.

Opzioni:
  -h, --help              Mostra questo messaggio
  -v, --version TAG       Sovrascrive il tag versione (default: <semver>-<gitSha>)
  --skip-typecheck        Salta pnpm typecheck
  --skip-build            Salta la build (solo con singola piattaforma + immagine locale)
  --skip-login            Non tenta docker login (usa credenziali già in cache)
  --skip-push             Build multi-arch senza docker push
  --dry-run               Stampa i comandi senza eseguirli

Variabili (docker_oracle/.env o ambiente):
  OCIR_REGION             Regione OCI (es. eu-milan-1)
  OCIR_NAMESPACE          Namespace tenancy OCIR
  OCIR_REPO               Nome repository (default: digitiamo/paperclip)
  OCIR_HOST               Host registry (opzionale, derivato da OCIR_REGION)
  OCIR_USERNAME           Utente login: <namespace>/<oci-username>
  OCIR_PASSWORD           Auth token OCI (non committare)
  DOCKER_TARGET           Target Dockerfile (default: production; alternativa: cloud)
  DOCKER_PLATFORMS        Piattaforme buildx (default: nativa host prima, poi cross)
  DOCKER_BUILDX_BUILDER   Nome builder buildx (default: paperclip-multiarch)
  PUSH_SEMVER             true|false — tag aggiuntivo <semver> (default: true)
  PUSH_LATEST             true|false — tag latest (default: true)

Esempi:
  ./docker_oracle/publish.sh
  ./docker_oracle/publish.sh --version 0.3.1-rc1
  DOCKER_PLATFORMS=linux/amd64 ./docker_oracle/publish.sh --skip-typecheck
  PUSH_LATEST=false ./docker_oracle/publish.sh --skip-push
  ./docker_oracle/publish.sh --skip-typecheck --dry-run
EOF
}

log() {
  printf '==> %s\n' "$*"
}

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      VERSION_OVERRIDE="${2:?--version richiede un valore}"
      shift 2
      ;;
    --skip-typecheck) SKIP_TYPECHECK=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-login) SKIP_LOGIN=true; shift ;;
    --skip-push) SKIP_PUSH=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *)
      echo "Opzione sconosciuta: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Salva override da CLI/shell: load_docker_env non deve sovrascriverli.
# Nota: [[ -v VAR ]] richiede bash 4.2+; macOS usa ancora bash 3.2.
_PUSH_SEMVER_FROM_CLI=false
_PUSH_LATEST_FROM_CLI=false
_DOCKER_PLATFORMS_FROM_CLI=false
if [ -n "${PUSH_SEMVER+x}" ]; then
  _PUSH_SEMVER_FROM_CLI=true
  _PUSH_SEMVER_CLI_VAL="${PUSH_SEMVER}"
fi
if [ -n "${PUSH_LATEST+x}" ]; then
  _PUSH_LATEST_FROM_CLI=true
  _PUSH_LATEST_CLI_VAL="${PUSH_LATEST}"
fi
if [ -n "${DOCKER_PLATFORMS+x}" ]; then
  _DOCKER_PLATFORMS_FROM_CLI=true
  _DOCKER_PLATFORMS_CLI_VAL="${DOCKER_PLATFORMS}"
fi

load_docker_env "$DOCKER_DIR"

if [[ "$_PUSH_SEMVER_FROM_CLI" == "true" ]]; then
  PUSH_SEMVER="${_PUSH_SEMVER_CLI_VAL}"
fi
if [[ "$_PUSH_LATEST_FROM_CLI" == "true" ]]; then
  PUSH_LATEST="${_PUSH_LATEST_CLI_VAL}"
fi
if [[ "$_DOCKER_PLATFORMS_FROM_CLI" == "true" ]]; then
  DOCKER_PLATFORMS="${_DOCKER_PLATFORMS_CLI_VAL}"
fi

: "${OCIR_REGION:?imposta OCIR_REGION in docker_oracle/.env o nell ambiente}"
: "${OCIR_NAMESPACE:?imposta OCIR_NAMESPACE in docker_oracle/.env o nell ambiente}"

OCIR_REPO="${OCIR_REPO:-digitiamo/paperclip}"
DOCKER_TARGET="${DOCKER_TARGET:-production}"
DOCKER_PLATFORMS="${DOCKER_PLATFORMS:-$(default_publish_platforms)}"
PUSH_SEMVER="${PUSH_SEMVER:-true}"
PUSH_LATEST="${PUSH_LATEST:-true}"

OCIR_HOST="${OCIR_HOST:-$(ocir_host_for_region "$OCIR_REGION")}"

VERSION_TAG="$(resolve_image_version_tag "$REPO_ROOT" "$VERSION_OVERRIDE")"
SEMVER_TAG="$(resolve_semver_tag "$REPO_ROOT")"
GIT_SHA="$(git_short_sha "$REPO_ROOT")"
GIT_FULL="$(git_full_sha "$REPO_ROOT")"
CLI_TOOLS_CACHE_EPOCH="${CLI_TOOLS_CACHE_EPOCH:-$(cli_tools_cache_epoch)}"
DOCKERFILE="${DOCKERFILE:-${REPO_ROOT}/Dockerfile}"

LOCAL_IMAGE="paperclip:${VERSION_TAG}"
REMOTE_BASE="${OCIR_HOST}/${OCIR_NAMESPACE}/${OCIR_REPO}"

TAGS_TO_PUSH=("${VERSION_TAG}")
if [[ "$PUSH_SEMVER" == "true" && "$SEMVER_TAG" != "$VERSION_TAG" ]]; then
  TAGS_TO_PUSH+=("${SEMVER_TAG}")
fi
if [[ "$PUSH_LATEST" == "true" ]]; then
  TAGS_TO_PUSH+=("latest")
fi

log "Publish Paperclip → OCIR"
echo "  package version : ${SEMVER_TAG}"
echo "  git sha         : ${GIT_SHA}"
echo "  image tag       : ${VERSION_TAG}"
echo "  docker target   : ${DOCKER_TARGET}"
echo "  platforms       : ${DOCKER_PLATFORMS}"
echo "  registry        : ${OCIR_HOST}"
echo "  repository      : ${OCIR_REPO}"
echo "  tags remoti     : ${TAGS_TO_PUSH[*]}"
echo ""

if [[ "$SKIP_TYPECHECK" != "true" ]]; then
  log "Typecheck"
  run pnpm typecheck
fi

if [[ "$SKIP_LOGIN" != "true" ]]; then
  if [[ -n "${OCIR_USERNAME:-}" && -n "${OCIR_PASSWORD:-}" ]]; then
    log "Docker login su ${OCIR_HOST}"
  else
    log "Docker login: salto auto-login (imposta OCIR_USERNAME e OCIR_PASSWORD in docker_oracle/.env)"
  fi
  if [[ -n "${OCIR_USERNAME:-}" && -n "${OCIR_PASSWORD:-}" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '[dry-run] docker login %s -u %s --password-stdin\n' "$OCIR_HOST" "$(normalize_ocir_secret "$OCIR_USERNAME")"
    else
      ocir_docker_login "$OCIR_HOST" "$OCIR_USERNAME" "$OCIR_PASSWORD"
    fi
  elif [[ "$DRY_RUN" != "true" ]]; then
    if ! docker login "$OCIR_HOST" 2>/dev/null; then
      echo "Login OCIR non configurato. Esegui:" >&2
      echo "  docker login ${OCIR_HOST} -u '<${OCIR_NAMESPACE}/<oci-username>>' -p '<auth-token>'" >&2
      echo "oppure imposta OCIR_USERNAME e OCIR_PASSWORD in docker_oracle/.env" >&2
      exit 1
    fi
  fi
fi

if [[ "$SKIP_BUILD" == "true" ]]; then
  if is_multi_platform "${DOCKER_PLATFORMS}"; then
    echo "--skip-build non è supportato con multi-platform (serve buildx --push del manifest)." >&2
    echo "Usa una sola piattaforma (DOCKER_PLATFORMS=linux/amd64) oppure ometti --skip-build." >&2
    exit 1
  fi
  log "Build saltata (--skip-build)"
  if [[ "$DRY_RUN" != "true" ]] && ! docker image inspect "${LOCAL_IMAGE}" >/dev/null 2>&1; then
    echo "Immagine locale assente: ${LOCAL_IMAGE}" >&2
    exit 1
  fi
  log "Tag per OCIR"
  for tag in "${TAGS_TO_PUSH[@]}"; do
    remote="${REMOTE_BASE}:${tag}"
    echo "  ${LOCAL_IMAGE} -> ${remote}"
    run docker tag "${LOCAL_IMAGE}" "${remote}"
  done
  if [[ "$SKIP_PUSH" == "true" ]]; then
    log "Push saltato (--skip-push)"
    exit 0
  fi
  log "Push su OCIR"
  for tag in "${TAGS_TO_PUSH[@]}"; do
    remote="${REMOTE_BASE}:${tag}"
    run docker push "${remote}"
  done
else
  # Multi-arch: una piattaforma alla volta (evita OOM QEMU), poi imagetools.
  # Singola piattaforma nativa: `docker build` (niente builder container → meno RAM).
  # (evitare mapfile: macOS shippa ancora bash 3.2)
  PLATFORM_LIST=()
  while IFS= read -r _plat; do
    [[ -n "$_plat" ]] && PLATFORM_LIST+=("$_plat")
  done < <(iter_platforms "${DOCKER_PLATFORMS}")
  if [[ ${#PLATFORM_LIST[@]} -eq 0 ]]; then
    echo "DOCKER_PLATFORMS vuoto o non valido: ${DOCKER_PLATFORMS}" >&2
    exit 1
  fi

  common_build_args=(
    -f "${DOCKERFILE}"
    --target "${DOCKER_TARGET}"
    --build-arg "PAPERCLIP_BUILD_VERSION=${VERSION_TAG}"
    --build-arg "PAPERCLIP_BUILD_COMMIT=${GIT_FULL}"
    --build-arg "CLI_TOOLS_CACHE_EPOCH=${CLI_TOOLS_CACHE_EPOCH}"
    --build-arg "NODE_MAX_OLD_SPACE_SIZE=${NODE_MAX_OLD_SPACE_SIZE:-3072}"
  )

  if [[ ${#PLATFORM_LIST[@]} -eq 1 ]] && is_native_platform "${PLATFORM_LIST[0]}"; then
    platform="${PLATFORM_LIST[0]}"
    log "Docker build nativo ${platform} → ${LOCAL_IMAGE} (senza buildx container)"
    build_cmd=(
      docker build
      "${common_build_args[@]}"
      --platform "${platform}"
      -t "${LOCAL_IMAGE}"
      "${REPO_ROOT}"
    )
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '[dry-run]'
      printf ' %q' "${build_cmd[@]}"
      printf '\n'
    else
      "${build_cmd[@]}"
    fi

    log "Tag per OCIR"
    for tag in "${TAGS_TO_PUSH[@]}"; do
      remote="${REMOTE_BASE}:${tag}"
      echo "  ${LOCAL_IMAGE} -> ${remote}"
      run docker tag "${LOCAL_IMAGE}" "${remote}"
    done

    if [[ "$SKIP_PUSH" == "true" ]]; then
      log "Push saltato (--skip-push)"
      exit 0
    fi

    log "Push su OCIR"
    for tag in "${TAGS_TO_PUSH[@]}"; do
      remote="${REMOTE_BASE}:${tag}"
      run docker push "${remote}"
    done
  else
    log "Buildx ${DOCKER_PLATFORMS} → ${REMOTE_BASE}"
    if [[ "$DRY_RUN" != "true" ]]; then
      ensure_buildx_builder
    else
      printf '[dry-run] ensure_buildx_builder\n'
    fi

    if [[ ${#PLATFORM_LIST[@]} -eq 1 ]]; then
      platform="${PLATFORM_LIST[0]}"
      log "Build piattaforma ${platform} (cross via QEMU — più lenta/RAM)"
      build_cmd=(
        docker buildx build
        "${common_build_args[@]}"
        --platform "${platform}"
      )
      for tag in "${TAGS_TO_PUSH[@]}"; do
        build_cmd+=(-t "${REMOTE_BASE}:${tag}")
      done
      if [[ "$SKIP_PUSH" != "true" ]]; then
        build_cmd+=(--push)
      else
        build_cmd+=(--load -t "${LOCAL_IMAGE}")
      fi
      build_cmd+=("${REPO_ROOT}")

      if [[ "$DRY_RUN" == "true" ]]; then
        printf '[dry-run]'
        printf ' %q' "${build_cmd[@]}"
        printf '\n'
      else
        "${build_cmd[@]}"
      fi
    else
      HOST_PLATFORM="$(host_docker_platform 2>/dev/null || true)"
      ARCH_REF_TAGS=()
      for platform in "${PLATFORM_LIST[@]}"; do
        suffix="$(platform_tag_suffix "$platform")"
        arch_ref_tag="${VERSION_TAG}-${suffix}"
        arch_ref="${REMOTE_BASE}:${arch_ref_tag}"
        ARCH_REF_TAGS+=("${arch_ref}")

        if [[ -n "$HOST_PLATFORM" && "$platform" != "$HOST_PLATFORM" ]]; then
          log "Build piattaforma ${platform} → ${arch_ref} (cross via QEMU — più lenta/RAM)"
        else
          log "Build piattaforma ${platform} → ${arch_ref}"
        fi
        build_cmd=(
          docker buildx build
          "${common_build_args[@]}"
          --platform "${platform}"
          -t "${arch_ref}"
        )
        if [[ "$SKIP_PUSH" != "true" ]]; then
          build_cmd+=(--push)
        fi
        build_cmd+=("${REPO_ROOT}")

        if [[ "$DRY_RUN" == "true" ]]; then
          printf '[dry-run]'
          printf ' %q' "${build_cmd[@]}"
          printf '\n'
        else
          "${build_cmd[@]}"
        fi
      done

      if [[ "$SKIP_PUSH" == "true" ]]; then
        log "Push saltato (--skip-push); build per-arch in cache buildx (senza manifest list)"
        exit 0
      fi

      log "Crea manifest list multi-arch"
      for tag in "${TAGS_TO_PUSH[@]}"; do
        manifest_cmd=(
          docker buildx imagetools create
          -t "${REMOTE_BASE}:${tag}"
          "${ARCH_REF_TAGS[@]}"
        )
        if [[ "$DRY_RUN" == "true" ]]; then
          printf '[dry-run]'
          printf ' %q' "${manifest_cmd[@]}"
          printf '\n'
        else
          "${manifest_cmd[@]}"
        fi
      done
    fi

    if [[ "$SKIP_PUSH" == "true" ]]; then
      log "Push saltato (--skip-push)"
      exit 0
    fi
  fi
fi

echo ""
log "Pubblicazione completata"
echo "  Immagine principale: ${REMOTE_BASE}:${VERSION_TAG}"
echo "  Piattaforme        : ${DOCKER_PLATFORMS}"
for tag in "${TAGS_TO_PUSH[@]}"; do
  [[ "$tag" == "$VERSION_TAG" ]] && continue
  echo "  Anche pubblicato  : ${REMOTE_BASE}:${tag}"
done
echo ""
echo "Verifica manifest:"
echo "  docker buildx imagetools inspect ${REMOTE_BASE}:${VERSION_TAG}"
