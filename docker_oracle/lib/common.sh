# Funzioni condivise per build/publish su OCIR (source da script in docker_oracle/)

ocir_host_for_region() {
  case "$1" in
    eu-frankfurt-1) echo "fra.ocir.io" ;;
    eu-milan-1) echo "lin.ocir.io" ;;
    eu-amsterdam-1) echo "ams.ocir.io" ;;
    eu-madrid-1) echo "mad.ocir.io" ;;
    eu-paris-1) echo "cdg.ocir.io" ;;
    uk-london-1) echo "lhr.ocir.io" ;;
    us-ashburn-1) echo "iad.ocir.io" ;;
    us-phoenix-1) echo "phx.ocir.io" ;;
    *)
      echo "Regione OCIR non mappata: $1" >&2
      echo "Imposta OCIR_HOST oppure aggiungi il mapping in docker_oracle/lib/common.sh" >&2
      return 1
      ;;
  esac
}

load_docker_env() {
  local docker_dir="$1"
  if [[ -f "${docker_dir}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${docker_dir}/.env"
    set +a
  fi
}

# Versione da server/package.json (il root package.json non ha "version").
package_version() {
  local repo_root="$1"
  local pkg_json="${repo_root}/server/package.json"
  if [[ ! -f "$pkg_json" ]]; then
    pkg_json="${repo_root}/cli/package.json"
  fi
  node -pe "require('${pkg_json}').version" 2>/dev/null \
    || sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" | head -1
}

git_short_sha() {
  local repo_root="$1"
  git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M
}

git_full_sha() {
  local repo_root="$1"
  git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo ""
}

# Tag immagine: <semver>-<gitSha> (es. 0.3.1-a1b2c3d)
# Docker non ammette '+' nei tag; usiamo '-' al posto di '+' (build metadata semver).
resolve_image_version_tag() {
  local repo_root="$1"
  local override="${2:-}"

  if [[ -n "${override}" ]]; then
    echo "${override}"
    return 0
  fi

  local pkg sha
  pkg="$(package_version "$repo_root")"
  sha="$(git_short_sha "$repo_root")"
  echo "${pkg}-${sha}"
}

resolve_semver_tag() {
  local repo_root="$1"
  package_version "$repo_root"
}

# Epoch settimanale ISO: busta la cache dei CLI tool nell'immagine Paperclip.
cli_tools_cache_epoch() {
  date -u +%G-W%V 2>/dev/null || date -u +%Y-W%U
}

# Rimuove spazi/newline e virgolette esterne (comuni negli .env copiati a mano).
normalize_ocir_secret() {
  local value="${1:-}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

ocir_docker_login() {
  local host="$1"
  local username="$2"
  local password="$3"

  username="$(normalize_ocir_secret "$username")"
  password="$(normalize_ocir_secret "$password")"

  if [[ -z "$username" || -z "$password" ]]; then
    echo "OCIR_USERNAME e OCIR_PASSWORD non possono essere vuoti." >&2
    return 1
  fi

  if ! printf '%s' "$password" | docker login "$host" -u "$username" --password-stdin; then
    echo "" >&2
    echo "Login OCIR fallito (Unauthorized o credenziali non valide)." >&2
    echo "Verifica in docker_oracle/.env:" >&2
    echo "  - OCIR_USERNAME = <namespace>/<nome-utente-oci>" >&2
    echo "    es. ${OCIR_NAMESPACE:-<namespace>}/oracleidentitycloudservice/docker-pusher-01" >&2
    echo "  - OCIR_PASSWORD = Auth Token OCI (Profile utente → Auth Tokens), NON la password console" >&2
    echo "  - Il token deve appartenere allo stesso utente indicato in OCIR_USERNAME" >&2
    echo "  - L'utente deve avere permessi sul repository (es. use repos / manage repos)" >&2
    echo "" >&2
    echo "Test manuale:" >&2
    echo "  docker logout ${host} 2>/dev/null; docker login ${host} -u '<namespace>/<user>' -p '<auth-token>'" >&2
    return 1
  fi
}

# Default publish: entrambe le arch, con la nativa host per prima
# (su Apple Silicon evita di aprire con QEMU/amd64 → OOM tipico).
default_publish_platforms() {
  local native
  native="$(host_docker_platform 2>/dev/null || true)"
  case "$native" in
    linux/arm64) echo "linux/arm64,linux/amd64" ;;
    linux/amd64) echo "linux/amd64,linux/arm64" ;;
    *) echo "linux/amd64,linux/arm64" ;;
  esac
}

# Piattaforma nativa dell'host (per build locale / scelta docker vs buildx).
# Preferisce uname (sempre disponibile); se Docker risponde, usa Server.Arch.
host_docker_platform() {
  local arch docker_arch
  arch="$(uname -m)"
  docker_arch="$(docker version -f '{{.Server.Arch}}' 2>/dev/null || true)"
  if [[ -n "$docker_arch" ]]; then
    arch="$docker_arch"
  fi
  case "$arch" in
    amd64|x86_64) echo "linux/amd64" ;;
    arm64|aarch64) echo "linux/arm64" ;;
    *)
      echo "Architettura Docker non supportata per --load: ${arch}" >&2
      return 1
      ;;
  esac
}

# True se DOCKER_PLATFORMS elenca più di una piattaforma.
is_multi_platform() {
  local platforms="${1:-}"
  [[ "$platforms" == *,* ]]
}

# Splitta "linux/amd64,linux/arm64" in array (nomi via nameref bash 4.3+ non portabile:
# stampa una piattaforma per riga, trim spazi).
iter_platforms() {
  local platforms="${1:-}"
  local IFS=','
  local p
  # shellcheck disable=SC2086
  for p in ${platforms}; do
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    [[ -n "$p" ]] && printf '%s\n' "$p"
  done
}

# linux/amd64 → linux-amd64 (suffisso tag intermedio per arch).
platform_tag_suffix() {
  local platform="$1"
  echo "${platform//\//-}"
}

# True se la piattaforma richiesta è quella nativa dell'host Docker.
is_native_platform() {
  local platform="${1:-}"
  local host
  host="$(host_docker_platform 2>/dev/null || true)"
  [[ -n "$platform" && -n "$host" && "$platform" == "$host" ]]
}

# Assicura un builder buildx capace di multi-platform (Docker Desktop / QEMU).
# Usare solo per cross-build / multi-arch: il driver docker-container consuma molta RAM.
ensure_buildx_builder() {
  local builder_name="${DOCKER_BUILDX_BUILDER:-paperclip-multiarch}"

  if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx non disponibile. Aggiorna Docker Desktop / abilita BuildKit." >&2
    return 1
  fi

  if ! docker buildx inspect "$builder_name" >/dev/null 2>&1; then
    echo "Creo builder buildx '${builder_name}'..."
    docker buildx create --name "$builder_name" --driver docker-container --use >/dev/null
  else
    docker buildx use "$builder_name" >/dev/null
  fi

  # Necessario per emulare arm64 su host amd64 (e viceversa) con QEMU.
  docker buildx inspect --bootstrap >/dev/null
}
