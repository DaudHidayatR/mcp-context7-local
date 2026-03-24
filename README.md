# Context7 Local Platform

This repository is a local runner-first MCP platform for AI agents. It provides:

- a local MCP endpoint for agents at `http://127.0.0.1:3200/mcp`
- project context via `get_project_context`
- skill discovery and whole-document skill loading
- RAG-backed code and docs retrieval via ChromaDB
- project memory through either in-process memory or the legacy durable stack

Core components:

- `context7-gateway`: HTTP wrapper around `@upstash/context7-mcp`
- `runner`: Bun service that owns the agent-facing MCP tool surface
- `packages/mcp-client`: reusable MCP client layer
- `packages/rag`: Chroma-backed local retrieval over mounted corpora
- `chromadb`: vector database used by the runner

The gateway keeps the same public MCP surface:

- `GET /health`
- `GET /sse`
- `POST /message?sessionId=...`
- `POST /mcp`
- `DELETE /mcp`

## AI Orientation

If you are configuring an AI agent or MCP client for this repo, start here:

- [CLAUDE.md](./CLAUDE.md): Claude-oriented repo instructions
- [agent.md](./agent.md): generic AI-agent instructions
- [docs/agent-system-prompt.md](./docs/agent-system-prompt.md): fuller system-prompt style protocol

Key defaults for agents:

- connect to `http://127.0.0.1:3200/mcp`
- use namespace `mcp-context7-local`
- load project context before code work
- use `rag_search` before modifying existing code
- use `./scripts/compose.sh legacy` if durable memory is required

## Quick Start

```bash
cp .env.example .env
chmod +x scripts/compose.sh start-context7-mcp.sh
./scripts/compose.sh build
./scripts/compose.sh up
./scripts/compose.sh health
./scripts/compose.sh doctor
```

The default Docker startup is the low-RAM runner-first stack: `context7-gateway`, `runner`, and `chromadb`.

If you need durable memory or the older split services, start the legacy profile:

```bash
./scripts/compose.sh legacy
```

The gateway binds to `127.0.0.1:3100` by default. The runner and Chroma stay internal to the compose network.

## Runner-First Workflow

The local runner is the default workflow for project-aware context and memory.

In the default Docker stack, `memory_*` MCP tools use the runner's in-process memory store. This keeps RAM lower and avoids booting Postgres by default, but memory entries do not survive a runner container restart.

If you need durable cross-restart memory, use `./scripts/compose.sh legacy`.

Create a new project with:

```bash
bun run scripts/setup-project.ts my-project --name "My Project"
```

That command is expected to create:

- `memory/my-project/` for namespace documents
- `memory/prd/my-project:prd:meta.json`
- `memory/prd/my-project:prd:goals.json`
- `memory/prd/my-project:prd:architecture.json`
- `memory/prd/my-project:prd:constraints.json`
- `memory/prd/my-project:prd:sops.json`

The setup flow is idempotent. Existing files are skipped, not overwritten.

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
runner MCP contract is the project-aware tool surface used by agents:
`rag_search`, `memory_read`, `memory_read_all`, `memory_write`,
`get_project_context`, `list_projects`, `list_skills`, and `load_skill`.

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

The remote Worker path is legacy and may not expose the full runner-first tool
surface yet. The gateway remains available separately on
`http://127.0.0.1:3100/mcp` for the legacy Context7 server surface.

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

Default stack:

- `context7-gateway`: public MCP entrypoint on `127.0.0.1:${GATEWAY_HOST_PORT:-3100}`
- `runner`: internal service with `/health`, `/ready`, `/refresh`, and `/query`
- `chromadb`: vector database used by the runner

Legacy profile:

- `postgres`: durable store for agent memory
- `memory-service`: HTTP memory service backed by Postgres
- `rag-service`: legacy Go RAG service

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
- `VPS_MEMORY_URL`: optional durable memory service URL; leave unset for the default low-RAM Docker mode
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

## Filesystem Contracts

The runner-first project contract uses the filesystem as the source of truth:

- `memory/<namespace>/` stores namespace documents that are indexed into RAG
- `memory/prd/<namespace>:prd:*.json` stores project context sections
- `memory/skills/index.json` stores the runtime skill registry
- `.agents/skills/*/SKILL.md` are the canonical whole-document skill sources referenced by the registry

The `memory/prd` files are read by `get_project_context`, and the skill registry is read by `list_skills` and `load_skill`.

## Scripts

- `bun run test:worker`
- `bun run test:go`
- `bun run test:all`
- `./scripts/compose.sh build`
- `./scripts/compose.sh up`
- `./scripts/compose.sh legacy`
- `./scripts/compose.sh down`
- `./scripts/compose.sh logs`
- `./scripts/compose.sh health`
- `./scripts/compose.sh doctor`
- `./scripts/compose.sh mcp`
- `./scripts/compose.sh restart`
- `./scripts/compose.sh ps`

`start-context7-mcp.sh` is kept as a deprecated shim and now delegates to `./scripts/compose.sh up`.
