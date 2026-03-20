#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT_DIR"

detect_engine() {
  if command -v podman >/dev/null 2>&1; then
    echo "podman"
  elif command -v docker >/dev/null 2>&1; then
    echo "docker"
  else
    echo "Error: neither podman nor docker was found in PATH." >&2
    exit 1
  fi
}

detect_compose() {
  local engine="$1"

  if "$engine" compose version >/dev/null 2>&1; then
    echo "$engine compose"
    return
  fi

  if [ "$engine" = "podman" ] && command -v podman-compose >/dev/null 2>&1; then
    echo "podman-compose"
    return
  fi

  if [ "$engine" = "docker" ] && command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi

  echo "Error: no compose provider found for engine '$engine'." >&2
  exit 1
}

ENGINE="$(detect_engine)"
COMPOSE="$(detect_compose "$ENGINE")"
COMPOSE_FILE="${COMPOSE_FILE:-compose.yml}"
GATEWAY_IMAGE="${GATEWAY_IMAGE_NAME:-local/context7-gateway}:${GATEWAY_IMAGE_TAG:-1.0.31}"

log() {
  echo "[compose.sh] $*"
}

compose() {
  $COMPOSE -f "$COMPOSE_FILE" "$@"
}

load_env() {
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
}

ensure_env() {
  if [[ ! -f ".env" ]]; then
    cp .env.example .env
    echo "Created .env from .env.example. Set CONTEXT7_API_KEY before continuing." >&2
    exit 1
  fi

  if ! grep -q '^CONTEXT7_API_KEY=' .env || grep -q '^CONTEXT7_API_KEY=your_api_key_here$' .env; then
    echo "Error: set a real CONTEXT7_API_KEY in .env before starting." >&2
    exit 1
  fi
}

service_health() {
  local service="$1"
  local container
  container=$($ENGINE ps --format "{{.Names}}" | grep "$service" | head -1 || true)
  if [[ -z "$container" ]]; then
    echo "  $service: NOT RUNNING"
    return
  fi

  local status
  status=$($ENGINE inspect --format "{{.State.Health.Status}}" "$container" 2>/dev/null || echo "running")
  echo "  $service ($container): $status"
}

CMD="${1:-help}"
shift || true

case "$CMD" in
  build)
    log "Building platform images..."
    compose build "$@"
    ;;

  up)
    ensure_env
    log "Starting context7-gateway in daemon mode..."
    compose up -d "$@"
    ;;

  down)
    log "Stopping services..."
    compose down "$@"
    ;;

  logs)
    compose logs -f "${@:-context7-gateway}"
    ;;

  health)
    log "Checking service health..."
    service_health context7-gateway
    service_health chroma
    service_health runner
    gateway_port="${GATEWAY_HOST_PORT:-3100}"
    if curl -fsS "http://127.0.0.1:${gateway_port}/health"; then
      printf '\n'
    else
      echo "Gateway health check failed on 127.0.0.1:${gateway_port}" >&2
      exit 1
    fi
    ;;

  doctor)
    ensure_env
    load_env
    gateway_port="${GATEWAY_HOST_PORT:-3100}"
    gateway_url="http://127.0.0.1:${gateway_port}"
    tmp_headers="$(mktemp)"
    tmp_body="$(mktemp)"
    trap 'rm -f "$tmp_headers" "$tmp_body"' EXIT

    auth_args=()
    if [[ -n "${GATEWAY_AUTH_TOKEN:-}" ]]; then
      auth_args=(-H "Authorization: Bearer ${GATEWAY_AUTH_TOKEN}")
    fi

    init_body='{"jsonrpc":"2.0","id":"doctor-init","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"compose-doctor","version":"1.0.0"}}}'
    initialized_body='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    tools_body='{"jsonrpc":"2.0","id":"doctor-tools","method":"tools/list","params":{}}'

    log "Doctor: /health"
    curl -fsS "${auth_args[@]}" "${gateway_url}/health" >/dev/null

    log "Doctor: initialize"
    curl -sS --max-time 12 -D "$tmp_headers" -o "$tmp_body" \
      -X POST "${gateway_url}/mcp" \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      "${auth_args[@]}" \
      --data "$init_body"

    init_status="$(awk 'NR==1 { print $2 }' "$tmp_headers")"
    if [[ "$init_status" != "200" ]]; then
      echo "Doctor initialize failed with HTTP ${init_status}" >&2
      sed -n '1,20p' "$tmp_headers" >&2
      sed -n '1,40p' "$tmp_body" >&2
      exit 1
    fi

    session_id="$(awk 'BEGIN { IGNORECASE = 1 } /^Mcp-Session-Id:/ { gsub("\r", "", $2); print $2; exit }' "$tmp_headers")"
    if [[ -z "$session_id" ]]; then
      echo "Doctor initialize failed: missing Mcp-Session-Id" >&2
      sed -n '1,20p' "$tmp_headers" >&2
      exit 1
    fi

    log "Doctor: notifications/initialized"
    initialized_status="$(
      curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
        -X POST "${gateway_url}/mcp" \
        -H 'Accept: application/json, text/event-stream' \
        -H 'Content-Type: application/json' \
        -H "Mcp-Session-Id: ${session_id}" \
        "${auth_args[@]}" \
        --data "$initialized_body"
    )"
    if [[ "$initialized_status" != "202" ]]; then
      echo "Doctor initialized notification failed with HTTP ${initialized_status}" >&2
      exit 1
    fi

    log "Doctor: tools/list"
    curl -sS --max-time 12 -D "$tmp_headers" -o "$tmp_body" \
      -X POST "${gateway_url}/mcp" \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      -H "Mcp-Session-Id: ${session_id}" \
      "${auth_args[@]}" \
      --data "$tools_body"

    tools_status="$(awk 'NR==1 { print $2 }' "$tmp_headers")"
    if [[ "$tools_status" != "200" ]]; then
      echo "Doctor tools/list failed with HTTP ${tools_status}" >&2
      sed -n '1,20p' "$tmp_headers" >&2
      sed -n '1,60p' "$tmp_body" >&2
      exit 1
    fi

    if ! grep -q 'resolve-library-id' "$tmp_body"; then
      echo "Doctor tools/list failed: expected tool payload was not returned" >&2
      sed -n '1,60p' "$tmp_body" >&2
      exit 1
    fi

    log "Doctor passed"
    ;;

  mcp)
    ensure_env
    log "Attaching to Context7 stdio directly (no TTY)..."
    $ENGINE run --rm -T \
      --env-file .env \
      "$GATEWAY_IMAGE" \
      bun run node_modules/@upstash/context7-mcp/dist/index.js "$@"
    ;;

  restart)
    ensure_env
    compose restart "${@:-context7-gateway}"
    ;;

  ps)
    compose ps
    ;;

  exec)
    compose exec "$@"
    ;;

  help|*)
    cat <<'EOF'
Usage: ./scripts/compose.sh <command> [args]

Commands:
  build              Build platform images
  up [svc]           Start all services or one service in the background
  down               Stop and remove platform containers
  logs [service]     Follow logs (default: context7-gateway)
  health             Check service health plus gateway HTTP health
  doctor             Probe /health, initialize, initialized, and tools/list
  mcp                Attach Context7 stdio directly for testing
  restart [service]  Restart services
  ps                 List services
  exec <svc> <cmd>   Execute a command in a running service
EOF
    ;;
esac
