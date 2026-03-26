# Agent Instructions

## What This Project Is

`mcp-context7-local` is a local runner-first MCP platform for AI agents. Its
main local MCP endpoint is `http://127.0.0.1:3200/mcp`.

The project is designed to give an AI agent:

- project context from filesystem-backed PRD files
- RAG search over local docs and code-adjacent corpus files
- project memory
- skill discovery and whole-document skill loading from local skills.sh-compatible `SKILL.md` files

## Canonical Namespace

- Namespace for this repository: `mcp-context7-local`
- Use the slug exactly as written

## Recommended Session Protocol

Before changing code, load project context:

```text
get_project_context("general", "mcp-context7-local")
```

Then load prior memory:

```text
memory_read_all(scope="project", namespace="mcp-context7-local")
```

If the task is feature development, security review, or incident response, use
the corresponding `task_type` with `get_project_context`.

Before editing existing files, run:

```text
rag_search(query="{what you are about to change}", namespace="mcp-context7-local", top_k=5)
```

## Available Runner Tools

- `rag_search`
- `memory_read`
- `memory_read_all`
- `memory_write`
- `get_project_context`
- `list_projects`
- `resolve_skill`
- `list_skills`
- `load_skill`

## Tool Usage Guidance

- `get_project_context`: load project goals, constraints, and architecture
- `rag_search`: inspect current patterns before modifying files
- `memory_read` and `memory_read_all`: review prior decisions and session data
- `memory_write`: persist decisions and summaries before ending work
- `resolve_skill`: find and load the most relevant procedural skill for the current task
- `list_skills` and `load_skill`: manual fallback for discovering and loading procedural knowledge from the runtime skill registry

## Endpoint Guidance

- Preferred local endpoint: `http://127.0.0.1:3200/mcp`
- Legacy local gateway endpoint: `http://127.0.0.1:3100/mcp`
- Legacy remote endpoint: `https://<your-worker>.workers.dev`

Prefer the local runner endpoint because it exposes the full runner-first tool
surface.

## Memory Mode

Local Docker usage has two modes:

- `./scripts/compose.sh up`: lower-RAM default mode
- `./scripts/compose.sh legacy`: enables durable memory and legacy services

In default mode, project memory may be in-process only and may not survive a
runner restart. Use `legacy` mode if the agent needs durable cross-restart
memory.

## Important Paths

- `memory/<namespace>/`: namespace documents for RAG
- `memory/prd/<namespace>:prd:*.json`: project context source
- `memory/skills/index.json`: skill registry
- `.agents/skills/*/SKILL.md`: canonical skill documents

Local skills in `.agents/skills` are repo-tracked files. Some mirror official
upstream Anthropic skills and some remain custom local skills. Source tracking
lives in `skills-lock.json`, and the current inventory is documented in
`docs/skill-sources.md`. The runner does not auto-install remote Skills CLI
packages at runtime.

## Reference

For a more detailed system-prompt style protocol, see
[docs/agent-system-prompt.md](./docs/agent-system-prompt.md).
