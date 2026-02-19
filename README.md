# Context7 MCP (Docker/Compose)

This setup builds a lean image for Context7 MCP with Bun and avoids running `npx` on every start.
On this machine, the image dropped from about 144 MB (Node build) to about 130 MB (Bun build).

## Files

- `Dockerfile`: multi-stage build using Bun (`oven/bun:alpine`) for a smaller runtime footprint.
- `docker-compose.yml`: service for MCP stdio usage.
- `.env.example`: required and optional environment variables.

## Build

```bash
cd context7_local
cp .env.example .env
docker compose build
```

## Run (manual test)

```bash
docker compose run --rm -T context7-mcp
```

The process should stay attached on stdio, which is expected for MCP servers.

## VS Code MCP config (compose)

Use this in your MCP server config:

```json
{
  "type": "stdio",
  "command": "docker",
  "args": [
    "compose",
    "-f",
    "/home/sagash/project/context7_local/docker-compose.yml",
    "run",
    "--rm",
    "-T",
    "context7-mcp"
  ],
  "env": {
    "CONTEXT7_API_KEY": "${input:CONTEXT7_API_KEY}",
    "CLIENT_IP_ENCRYPTION_KEY": "${input:CLIENT_IP_ENCRYPTION_KEY}"
  }
}
```

## VS Code MCP config (direct image, no compose)

After `docker compose build`, you can also run the built image directly:

```json
{
  "type": "stdio",
  "command": "docker",
  "args": [
    "run",
    "--rm",
    "-i",
    "-e",
    "CONTEXT7_API_KEY",
    "-e",
    "CLIENT_IP_ENCRYPTION_KEY",
    "localhost/local/context7-mcp:1.0.31"
  ],
  "env": {
    "CONTEXT7_API_KEY": "${input:CONTEXT7_API_KEY}",
    "CLIENT_IP_ENCRYPTION_KEY": "${input:CLIENT_IP_ENCRYPTION_KEY}"
  }
}
```
