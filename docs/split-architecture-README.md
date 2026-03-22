# Legacy Split Architecture — Remote Worker Path

> This document is a historical reference for the older Cloudflare Worker plus VPS split architecture. It is not the primary setup guide for this repo anymore. Use [README.md](../README.md) for the runner-first local workflow and project bootstrap contract.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │           CF Worker (MCP Entrypoint)                      │  │
│  │                                                           │  │
│  │  POST / (JSON-RPC 2.0)                                    │  │
│  │    ├── tools/call: rag_search     ──► VPS RAG Service     │  │
│  │    ├── tools/call: memory_read    ──► VPS Memory Service  │  │
│  │    ├── tools/call: memory_write   ──► VPS Memory Service  │  │
│  │    └── tools/call: get_project_context ──► KV (PRD_KV)    │  │
│  │                                                           │  │
│  │  GET /health                                              │  │
│  │  Auth: Bearer token (SECRET env)                          │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                         │                      │
                    HTTPS (5s timeout)     HTTPS (5s timeout)
                         │                      │
┌────────────────────────┼──────────────────────┼─────────────────┐
│                        VPS                    │                 │
│  ┌─────────────────────▼───┐   ┌──────────────▼──────────────┐  │
│  │    RAG Service (Go)     │   │   Memory Service (Go)       │  │
│  │    :8081                │   │   :8082                     │  │
│  │                         │   │                              │  │
│  │  POST /search           │   │  POST /read                 │  │
│  │  POST /ingest           │   │  POST /write                │  │
│  │  GET  /health           │   │  POST /list                 │  │
│  │                         │   │  GET  /health               │  │
│  └──────────┬──────────────┘   └──────────┬──────────────────┘  │
│             │                              │                    │
│  ┌──────────▼──────────────┐   ┌──────────▼──────────────────┐  │
│  │    ChromaDB             │   │   PostgreSQL                │  │
│  │    :8000                │   │   :5432                     │  │
│  └─────────────────────────┘   └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

### Cloudflare Worker (`worker/wrangler.toml`)

| Variable | Description | Required |
|----------|-------------|----------|
| `SECRET` | Bearer token for auth (via `wrangler secret put`) | Yes |
| `VPS_RAG_URL` | Full URL to RAG service (e.g. `http://vps:8081`) | Yes |
| `VPS_MEMORY_URL` | Full URL to Memory service (e.g. `http://vps:8082`) | Yes |
| `PRD_KV` | KV namespace binding ID (in wrangler.toml) | Yes |

### RAG Service (`services/rag/`)

| Variable | Description | Default |
|----------|-------------|---------|
| `CHROMA_URL` | ChromaDB base URL | — (required) |
| `EMBED_URL` | OpenAI-compatible embedding endpoint | — (required) |
| `PORT` | Listen port | `8081` |

### Memory Service (`services/memory/`)

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | — (required) |
| `PORT` | Listen port | `8082` |

## Local Development

### Prerequisites

- Docker & Docker Compose
- Go 1.22+
- Node.js 18+ (for CF Worker dev)
- Wrangler CLI (`npm i -g wrangler`)

### Start All Services

```bash
# Start the split architecture stack (ChromaDB + Postgres + Go services)
docker compose -f docker-compose.yml up --build -d

# Verify health
curl http://localhost:8081/health   # RAG service
curl http://localhost:8082/health   # Memory service
```

### Run Go Tests

```bash
# Run Go service tests with writable temporary caches
bun run test:go
```

### Run Worker Tests

```bash
# Worker tests with correct failure detection
bun run test:worker
```

### Develop Worker Locally

```bash
cd worker
npx wrangler dev
```

## Deploy

### VPS (Go Services)

```bash
# Build binaries
cd services/rag && go build -o rag-service .
cd services/memory && go build -o memory-service .

# Copy to VPS and run via systemd or supervisor
# Ensure CHROMA_URL, EMBED_URL, DATABASE_URL are set
```

Example systemd unit (`/etc/systemd/system/rag-service.service`):
```ini
[Unit]
Description=RAG Service
After=network.target

[Service]
Type=simple
User=mcp
Environment=CHROMA_URL=http://localhost:8000
Environment=EMBED_URL=http://localhost:11434
Environment=PORT=8081
ExecStart=/opt/mcp/rag-service
Restart=always

[Install]
WantedBy=multi-user.target
```

### Cloudflare Worker

```bash
cd worker

# Set the secret
wrangler secret put SECRET

# Create KV namespace
wrangler kv namespace create PRD_KV
# → Update wrangler.toml with the returned namespace ID

# Deploy
wrangler deploy

# Populate PRD KV data
wrangler kv key put --binding=PRD_KV "prd:meta" '{"name":"MyProject","version":"1.0"}'
wrangler kv key put --binding=PRD_KV "prd:goals" '{"primary":"Ship v2"}'
wrangler kv key put --binding=PRD_KV "prd:constraints" '{"budget":"limited"}'
wrangler kv key put --binding=PRD_KV "prd:architecture" '{"components":["api","web"]}'
wrangler kv key put --binding=PRD_KV "prd:sops" '{"incident":"page oncall"}'
```

## File Structure

```
worker/
├── src/
│   ├── index.ts            # CF Worker MCP entrypoint
│   └── index.test.ts       # Worker tests
└── wrangler.toml            # CF config

services/
├── rag/
│   ├── main.go              # Go RAG HTTP server
│   ├── main_test.go         # RAG tests (mock ChromaDB)
│   ├── go.mod
│   └── Dockerfile
└── memory/
    ├── main.go              # Go Memory HTTP server
    ├── main_test.go         # Memory tests (in-memory store)
    ├── go.mod
    └── Dockerfile

docs/
├── agent-system-prompt.md   # Agent instructions for MCP tools
└── split-architecture-README.md  # This file

docker-compose.yml           # Local dev stack
```
