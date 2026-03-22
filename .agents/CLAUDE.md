# Claude Code Project Instructions

## MCP Server

- Connect to the local runner by default: `http://127.0.0.1:3200/mcp`
- Use the remote Worker endpoint only when needed:
  `https://<your-worker>.workers.dev`
- The same tool names and argument shapes work on both endpoints

## Namespace

- Namespace for this repo: `mcp-context7-local`
- Always use the lowercase slug exactly as written above

## Required Session Start

Before touching any code, always call:

```text
get_project_context("general","mcp-context7-local")
```

If the task is clearly feature work, a security review, or an incident, follow
up with the matching `task_type` for deeper context.

## MCP Tools

### `get_project_context`

Use at session start to load project goals, constraints, and architecture
context for this repo. This call is mandatory before any code work.

### `rag_search`

Use before modifying existing files or when you need to understand related code
paths, patterns, and nearby implementation details.

### `memory_read`

Use when you know the exact memory key you want to inspect, such as a prior
decision or a named session artifact.

### `memory_read_all`

Use early in a task to review prior project decisions, changed files, and open
questions stored for `mcp-context7-local`.

### `memory_write`

Use before ending the session to persist decisions, files changed, unresolved
questions, and a short summary for the next session.
