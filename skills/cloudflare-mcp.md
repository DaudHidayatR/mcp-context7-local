# Cloudflare MCP In This Repo

This repo can talk to a Cloudflare MCP server through the runner, but Cloudflare MCP is optional and is not enabled by default.

## Current Wiring

- The runner reads `MCP_CLOUDFLARE_URL` and `CF_API_TOKEN`
- The MCP client registers Cloudflare as server name `cloudflare`
- Cloudflare tools are prefixed and sanitized with `cf_`
- The default compose config leaves `MCP_CLOUDFLARE_URL` empty

## What Is Enabled By Default

- Local Context7 is enabled by default through `MCP_CONTEXT7_URL=http://context7-gateway:3100/mcp`
- The runner starts and works without Cloudflare MCP
- Queries currently call the first tool whose name ends with `resolve-library-id`, which comes from Context7 in the default setup

## How To Enable Cloudflare MCP

Set these env vars before starting or restarting the stack:

- `MCP_CLOUDFLARE_URL`
- `CF_API_TOKEN`

Then restart the platform:

```bash
./scripts/compose.sh up
```

After restart, confirm the runner sees Cloudflare by checking `/health` on the runner and looking for `cloudflare` in `enabledServers`.

## How To Reason About Tool Names

- Context7 tools look like `ctx7_*`
- Cloudflare tools look like `cf_*`
- Tool prefixing happens in `packages/mcp-client`

When adding runner flows, prefer explicit tool selection by prefix if the flow is Cloudflare-specific.
