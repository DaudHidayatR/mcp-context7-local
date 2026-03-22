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

print_doctor_result() {
  local label="$1"
  local status="$2"
  echo "  ${label}: ${status}"
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

doctor_mcp_check() {
  local label="$1"
  local endpoint="$2"
  local expected_tool="$3"
  local use_auth="${4:-0}"
  local tmp_headers
  local tmp_body
  local init_status
  local session_id
  local initialized_status
  local tools_status
  local -a curl_auth_args=()

  tmp_headers="$(mktemp)"
  tmp_body="$(mktemp)"
  trap 'rm -f "$tmp_headers" "$tmp_body"' RETURN

  if [[ "$use_auth" == "1" && ${#auth_args[@]} -gt 0 ]]; then
    curl_auth_args=("${auth_args[@]}")
  fi

  if ! curl -sS --max-time 12 -D "$tmp_headers" -o "$tmp_body" \
    -X POST "$endpoint" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    "${curl_auth_args[@]}" \
    --data "$init_body"; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} initialize request failed" >&2
    return 1
  fi

  init_status="$(awk 'NR==1 { print $2 }' "$tmp_headers")"
  if [[ "$init_status" != "200" ]]; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} initialize failed with HTTP ${init_status}" >&2
    sed -n '1,20p' "$tmp_headers" >&2
    sed -n '1,40p' "$tmp_body" >&2
    return 1
  fi

  session_id="$(awk 'BEGIN { IGNORECASE = 1 } /^Mcp-Session-Id:/ { gsub("\r", "", $2); print $2; exit }' "$tmp_headers")"
  if [[ -z "$session_id" ]]; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} initialize failed: missing Mcp-Session-Id" >&2
    sed -n '1,20p' "$tmp_headers" >&2
    return 1
  fi

  if ! initialized_status="$(
    curl -sS --max-time 12 -o /dev/null -w '%{http_code}' \
      -X POST "$endpoint" \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      -H "Mcp-Session-Id: ${session_id}" \
      "${curl_auth_args[@]}" \
      --data "$initialized_body"
  )"; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} initialized notification request failed" >&2
    return 1
  fi

  if [[ "$initialized_status" != "202" ]]; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} initialized notification failed with HTTP ${initialized_status}" >&2
    return 1
  fi

  if ! curl -sS --max-time 12 -D "$tmp_headers" -o "$tmp_body" \
    -X POST "$endpoint" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Mcp-Session-Id: ${session_id}" \
    "${curl_auth_args[@]}" \
    --data "$tools_body"; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} tools/list request failed" >&2
    return 1
  fi

  tools_status="$(awk 'NR==1 { print $2 }' "$tmp_headers")"
  if [[ "$tools_status" != "200" ]]; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} tools/list failed with HTTP ${tools_status}" >&2
    sed -n '1,20p' "$tmp_headers" >&2
    sed -n '1,60p' "$tmp_body" >&2
    return 1
  fi

  if ! grep -q "$expected_tool" "$tmp_body"; then
    print_doctor_result "${label} /mcp" "FAIL"
    echo "Doctor ${label} tools/list failed: expected tool '${expected_tool}' was not returned" >&2
    sed -n '1,60p' "$tmp_body" >&2
    return 1
  fi

  print_doctor_result "${label} /mcp" "PASS"
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
    runner_port="${RUNNER_HOST_PORT:-3200}"
    gateway_url="http://127.0.0.1:${gateway_port}"
    runner_url="http://127.0.0.1:${runner_port}"

    auth_args=()
    if [[ -n "${GATEWAY_AUTH_TOKEN:-}" ]]; then
      auth_args=(-H "Authorization: Bearer ${GATEWAY_AUTH_TOKEN}")
    fi

    init_body='{"jsonrpc":"2.0","id":"doctor-init","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"compose-doctor","version":"1.0.0"}}}'
    initialized_body='{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
    tools_body='{"jsonrpc":"2.0","id":"doctor-tools","method":"tools/list","params":{}}'

    log "Doctor checks"
    if curl -fsS "${auth_args[@]}" "${gateway_url}/health" >/dev/null; then
      print_doctor_result "gateway /health" "PASS"
    else
      print_doctor_result "gateway /health" "FAIL"
      echo "Gateway health check failed on 127.0.0.1:${gateway_port}" >&2
      exit 1
    fi

    doctor_mcp_check "gateway" "${gateway_url}/mcp" "resolve-library-id" 1
    log "Doctor: runner MCP endpoint"
    doctor_mcp_check "runner" "${runner_url}/mcp" "rag_search" 0

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
  doctor             Probe gateway /health plus gateway and runner MCP endpoints
  mcp                Attach Context7 stdio directly for testing
  restart [service]  Restart services
  ps                 List services
  exec <svc> <cmd>   Execute a command in a running service
EOF
    ;;
esac
