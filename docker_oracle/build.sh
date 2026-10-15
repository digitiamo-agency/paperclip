#!/usr/bin/env bash
#
# Build locale dell'immagine Paperclip (Dockerfile in root del repo).
# Default: piattaforma nativa host (caricabile con --load).
# Multi-arch: DOCKER_PLATFORMS=linux/amd64,linux/arm64 (senza --load; solo cache build).
#
set -euo pipefail

DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${DOCKER_DIR}/.." && pwd)"

# shellcheck source=lib/common.sh
source "${DOCKER_DIR}/lib/common.sh"

IMAGE_TAG="${IMAGE_TAG:-local}"
LOCAL_IMAGE="${LOCAL_IMAGE:-paperclip:${IMAGE_TAG}}"
DOCKER_TARGET="${DOCKER_TARGET:-production}"
DOCKERFILE="${DOCKERFILE:-${REPO_ROOT}/Dockerfile}"
DOCKER_PLATFORMS="${DOCKER_PLATFORMS:-$(host_docker_platform)}"

PAPERCLIP_BUILD_VERSION="${PAPERCLIP_BUILD_VERSION:-${IMAGE_TAG}}"
PAPERCLIP_BUILD_COMMIT="${PAPERCLIP_BUILD_COMMIT:-$(git_full_sha "$REPO_ROOT")}"
CLI_TOOLS_CACHE_EPOCH="${CLI_TOOLS_CACHE_EPOCH:-$(cli_tools_cache_epoch)}"

echo "==> Build ${LOCAL_IMAGE} (target=${DOCKER_TARGET})"
echo "  Dockerfile              : ${DOCKERFILE}"
echo "  platforms               : ${DOCKER_PLATFORMS}"
echo "  PAPERCLIP_BUILD_VERSION : ${PAPERCLIP_BUILD_VERSION}"
echo "  PAPERCLIP_BUILD_COMMIT  : ${PAPERCLIP_BUILD_COMMIT:-<empty>}"
echo "  CLI_TOOLS_CACHE_EPOCH   : ${CLI_TOOLS_CACHE_EPOCH}"
echo ""

ensure_buildx_builder

build_args=(
  buildx build
  -f "${DOCKERFILE}"
  --target "${DOCKER_TARGET}"
  --platform "${DOCKER_PLATFORMS}"
  --build-arg "PAPERCLIP_BUILD_VERSION=${PAPERCLIP_BUILD_VERSION}"
  --build-arg "PAPERCLIP_BUILD_COMMIT=${PAPERCLIP_BUILD_COMMIT}"
  --build-arg "CLI_TOOLS_CACHE_EPOCH=${CLI_TOOLS_CACHE_EPOCH}"
  -t "${LOCAL_IMAGE}"
)

if is_multi_platform "${DOCKER_PLATFORMS}"; then
  echo "Nota: multi-platform — l'immagine non viene caricata nel daemon locale (usa publish.sh --push)."
  echo ""
else
  build_args+=(--load)
fi

docker "${build_args[@]}" "${REPO_ROOT}"

if is_multi_platform "${DOCKER_PLATFORMS}"; then
  echo "Build multi-platform completata (cache buildx). Tag richiesto: ${LOCAL_IMAGE}"
else
  echo "Immagine locale: ${LOCAL_IMAGE}"
fi
