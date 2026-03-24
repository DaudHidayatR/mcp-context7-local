# Claude Instructions

## What This Project Is

`mcp-context7-local` is a local runner-first MCP platform for AI agents. The
main local endpoint is the Bun runner on `http://127.0.0.1:3200/mcp`.

The runner exposes project-aware tools for:

- project context loading
- RAG search over the local corpus
- project memory
- skill discovery and whole-document skill loading

The legacy gateway endpoint at `http://127.0.0.1:3100/mcp` is still available,
but the runner-first endpoint is the canonical local path.

## Namespace

- Repo namespace: `mcp-context7-local`
- Always use the lowercase slug exactly as written above

## Session Start

Before touching code, load context for this repo:

```text
get_project_context("general", "mcp-context7-local")
```

Then read prior memory:

```text
memory_read_all(scope="project", namespace="mcp-context7-local")
```

If the task clearly maps to feature work, security review, or incident
response, use the matching `task_type` with `get_project_context`.

## MCP Endpoint

- Default local endpoint: `http://127.0.0.1:3200/mcp`
- Legacy gateway endpoint: `http://127.0.0.1:3100/mcp`
- Legacy remote Worker path: `https://<your-worker>.workers.dev`

Prefer the local runner endpoint whenever possible because it has the complete
runner-first tool surface.

## Tools

### `get_project_context`

Use at session start. This is the canonical way to load repo goals,
constraints, and architecture for `mcp-context7-local`.

### `rag_search`

Use before modifying existing code or docs so you do not assume the current
codebase shape.

### `memory_read`

Use when you know the exact memory key you want, such as a specific prior
decision or session artifact.

### `memory_read_all`

Use near session start to load previous decisions, summaries, and open
questions for this namespace.

### `memory_write`

Use before ending a session to persist decisions, changed files, unresolved
questions, and a short summary.

### `list_projects`

Use when you need to discover valid project namespaces under the memory root.

### `list_skills`

Use to discover procedural skills exposed by the runner.

### `load_skill`

Use to load the full `SKILL.md` source for a relevant workflow.

## Memory Mode

There are two local stack modes:

- `./scripts/compose.sh up`: lower-RAM default stack
- `./scripts/compose.sh legacy`: enables durable memory and legacy services

In the default low-RAM stack, `memory_*` tools may use the runner's in-process
memory. That works for live sessions but does not persist across runner
restarts. Use `legacy` mode if durable memory matters.

## Filesystem Facts

- `memory/<namespace>/` contains namespace documents indexed into RAG
- `memory/prd/<namespace>:prd:*.json` backs `get_project_context`
- `memory/skills/index.json` backs `list_skills` and `load_skill`
- `.agents/skills/*/SKILL.md` are the canonical whole-document skill sources

## More Detail

For the fuller prompt-style protocol, see
[docs/agent-system-prompt.md](./docs/agent-system-prompt.md).
