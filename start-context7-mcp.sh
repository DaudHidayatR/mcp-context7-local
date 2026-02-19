#!/usr/bin/env bash

if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not in PATH."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(podman-compose)
else
  echo "Error: no compose command found (docker compose / docker-compose / podman-compose)."
  exit 1
fi

if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    echo "Created .env from .env.example."
    echo "Set CONTEXT7_API_KEY in .env, then run this script again."
    exit 1
  fi
  echo "Error: .env is missing."
  exit 1
fi

if ! grep -q '^CONTEXT7_API_KEY=' .env || grep -q '^CONTEXT7_API_KEY=your_api_key_here$' .env; then
  echo "Error: set a real CONTEXT7_API_KEY in .env before starting."
  exit 1
fi

# Load optional image overrides from .env.
set -a
. ./.env
set +a

IMAGE_NAME="${IMAGE_NAME:-local/context7-mcp}"
IMAGE_TAG="${IMAGE_TAG:-1.0.31}"
IMAGE_REF="${IMAGE_NAME}:${IMAGE_TAG}"

if ! docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
  echo "Building context7-mcp image..."
  "${COMPOSE_CMD[@]}" build context7-mcp
fi

exec "${COMPOSE_CMD[@]}" run -d --rm -T context7-mcp "$@"
