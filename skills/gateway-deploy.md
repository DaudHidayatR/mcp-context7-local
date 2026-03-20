# Gateway Deploy In This Repo

This repo runs the public MCP entrypoint as the `context7-gateway` service in `compose.yml`.

## Canonical Build And Run Paths

- Gateway Dockerfile: `services/context7-gateway/Dockerfile`
- Compose wrapper: `scripts/compose.sh`
- Public endpoint: `127.0.0.1:${GATEWAY_HOST_PORT:-3100}`

## Required Runtime Inputs

- `CONTEXT7_API_KEY` for the real Context7 child server

Optional but supported:

- `CLIENT_IP_ENCRYPTION_KEY`
- `GATEWAY_AUTH_TOKEN`
- `SESSION_TIMEOUT_MS`
- `REQUEST_TIMEOUT_MS`
- `CHILD_ENV_ALLOWLIST`
- `STDIO_CMD_JSON`

## Default Gateway Behavior

- Exposes `GET /health`
- Exposes `GET /sse` and `POST /message`
- Exposes `POST /mcp` and `DELETE /mcp`
- Spawns one stdio Context7 child process per session
- Binds only to localhost by default through compose port mapping

## Standard Operator Flow

```bash
./scripts/compose.sh build
./scripts/compose.sh up
./scripts/compose.sh health
```

Stop the stack with:

```bash
./scripts/compose.sh down
```

## Validation Checks

- `curl http://127.0.0.1:3100/health`
- `POST /mcp` with `tools/list`
- `./scripts/compose.sh ps`

If `/mcp` fails, check gateway logs first because most failures come from the spawned child command or missing env vars.
