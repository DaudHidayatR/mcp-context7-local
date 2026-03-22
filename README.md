# Context7 Local Platform

This repo now contains a small local platform around Context7:

- `context7-gateway`: HTTP wrapper around `@upstash/context7-mcp`
- `runner`: internal Bun service that talks to MCP servers and Chroma
- `packages/mcp-client`: reusable MCP client layer
- `packages/rag`: Chroma-backed local retrieval over mounted corpora
- `chroma`: vector database used by the runner

The gateway keeps the same public MCP surface:

- `GET /health`
- `GET /sse`
- `POST /message?sessionId=...`
- `POST /mcp`
- `DELETE /mcp`

## Quick Start

```bash
cp .env.example .env
chmod +x scripts/compose.sh start-context7-mcp.sh
./scripts/compose.sh build
./scripts/compose.sh up
./scripts/compose.sh health
./scripts/compose.sh doctor
```

The gateway binds to `127.0.0.1:3100` by default. The runner and Chroma stay internal to the compose network.

## MCP Client Config

HTTP MCP clients:

```json
{
  "mcpServers": {
    "mcp-context7-local": {
      "url": "http://127.0.0.1:3200/mcp"
    }
  }
}
```

This is the default agent-facing endpoint for the local Docker stack. The
runner exposes the project-aware MCP tools:
`rag_search`, `memory_read`, `memory_read_all`, `memory_write`, and
`get_project_context`.

If you want the remote deployment instead, use the same server name with your
Cloudflare Worker URL:

```json
{
  "mcpServers": {
    "mcp-context7-local": {
      "url": "https://<your-worker>.workers.dev"
    }
  }
}
```

The gateway remains available separately on `http://127.0.0.1:3100/mcp` for the
Context7 server surface.

SSE clients:

```json
{
  "mcpServers": {
    "context7": {
      "url": "http://127.0.0.1:3100/sse"
    }
  }
}
```

If you set `GATEWAY_AUTH_TOKEN`, send `Authorization: Bearer <token>` to `/sse`, `/message`, and `/mcp`.

## Services

- `context7-gateway`: public MCP entrypoint on `127.0.0.1:${GATEWAY_HOST_PORT:-3100}`
- `runner`: internal service with `/health`, `/ready`, `/refresh`, and `/query`
- `chroma`: internal vector database on port `8000`

Container builds are defined only in:

- `services/context7-gateway/Dockerfile`
- `apps/runner/Dockerfile`

## Local Development

```bash
bun install
bun test
bun run test:worker
bun run services/context7-gateway/src/index.ts
bun run apps/runner/src/index.ts
```

The runner spawns local CLI providers for `/query`. In v1:

- default provider is `codex`
- `gemini` is opt-in per request
- Gemini/Codex provider execution is intended for host development, not the current Docker runner image

The default gateway child command uses the installed `@upstash/context7-mcp` package from Bun's workspace layout. For local testing without the real server, you can override it with `STDIO_CMD_JSON`.

Example:

```bash
STDIO_CMD_JSON='["bun","test/fixtures/fake-stdio-mcp.ts"]' bun run services/context7-gateway/src/index.ts
```

## Environment

- `CONTEXT7_API_KEY`: required for the real Context7 server
- `CLIENT_IP_ENCRYPTION_KEY`: optional
- `GATEWAY_HOST_PORT`: host port mapping for the gateway, default `3100`
- `GATEWAY_AUTH_TOKEN`: optional bearer token
- `SESSION_TIMEOUT_MS`: idle session reap timeout, default `300000`
- `REQUEST_TIMEOUT_MS`: per-request timeout, default `30000`
- `CHILD_ENV_ALLOWLIST`: forwarded child env keys, default `CONTEXT7_API_KEY,CLIENT_IP_ENCRYPTION_KEY`
- `STDIO_CMD_JSON`: optional JSON array override for the spawned child command
- `MCP_CONTEXT7_URL`: runner-side URL for the local gateway
- `MCP_CLOUDFLARE_URL`: optional remote MCP URL
- `CF_API_TOKEN`: optional remote MCP bearer token
- `CHROMA_URL`: runner-side Chroma base URL
- `RAG_COLLECTION`: Chroma collection name
- `RAG_TOP_K`: runner retrieval depth
- `CODEX_CMD_JSON`: optional JSON array override for the Codex CLI command, default `["codex"]`
- `GEMINI_CMD_JSON`: optional JSON array override for the Gemini CLI command, default `["gemini"]`

## Runner Query API

`POST /query` accepts:

```json
{
  "query": "what is this project",
  "provider": "gemini"
}
```

Fields:

- `query`: required string
- `libraryName`: optional string used for the Context7 resolve tool
- `provider`: optional, one of `codex` or `gemini`, default `codex`

Successful responses include:

```json
{
  "query": "what is this project",
  "provider": "gemini",
  "llmResponse": "..."
}
```

If `provider: "gemini"` is explicitly requested and Gemini fails, the runner returns an error instead of falling back to Codex.

## Scripts

- `bun run test:worker`
- `bun run test:go`
- `bun run test:all`
- `./scripts/compose.sh build`
- `./scripts/compose.sh up`
- `./scripts/compose.sh down`
- `./scripts/compose.sh logs`
- `./scripts/compose.sh health`
- `./scripts/compose.sh doctor`
- `./scripts/compose.sh mcp`
- `./scripts/compose.sh restart`
- `./scripts/compose.sh ps`

`start-context7-mcp.sh` is kept as a deprecated shim and now delegates to `./scripts/compose.sh up`.
