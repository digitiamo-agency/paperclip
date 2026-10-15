#!/usr/bin/env bash
# Alias di publish.sh
set -euo pipefail
DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${DOCKER_DIR}/publish.sh" "$@"
