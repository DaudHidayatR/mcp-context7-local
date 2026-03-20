# Context7 Usage In This Repo

Context7 is the primary MCP dependency in this platform.

## Where It Is Used

- `context7-gateway` wraps the `@upstash/context7-mcp` stdio server
- `runner` calls the gateway through `MCP_CONTEXT7_URL`
- `packages/mcp-client` prefixes Context7 tools with `ctx7_`

## Default Tool Flow

The runner currently uses Context7 in a narrow way:

1. Index local repo knowledge into Chroma from `docs/`, `skills/`, `schemas/`, and `memory/`
2. Retrieve top-K local hits for a query
3. List MCP tools
4. If available, call the Context7 tool ending with `resolve-library-id`

That means the current query path is best for library lookup and documentation routing, not full autonomous multi-tool workflows.

## Tools Seen In Validation

- `ctx7_resolve-library-id`
- `ctx7_get-library-docs`

## Operational Notes

- The gateway child command resolves the installed package from Bun's workspace layout
- Real Context7 calls require `CONTEXT7_API_KEY`
- The runner may show `toolCount: 0` if the gateway child process cannot start or if the API key is missing

## When Editing This Repo

- Put repo-specific Context7 guidance in this `skills/` directory so the runner can retrieve it
- Do not store generic vendor instructions here if they already live in global Codex skills
- If you expand runner behavior to call `ctx7_get-library-docs`, keep the `ctx7_` prefix assumption explicit
