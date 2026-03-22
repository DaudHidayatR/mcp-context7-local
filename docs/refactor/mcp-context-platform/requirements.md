# MCP Context Platform Requirements

## Summary

This repository is moving toward a runner-first local platform. The current codebase already has a working Bun runner, a separate legacy worker/gateway path, a local RAG corpus, and a Postgres-backed memory service. The refactor contract is to make project context, skills, and project bootstrap filesystem-based on the runner path without changing the stable shared services.

## Actors

| Actor | Needs | Sends | Expects |
|---|---|---|---|
| AI Agent | Project context, prior decisions, relevant skill docs, fast tool responses | MCP JSON-RPC tool calls | Structured JSON, whole-document skill loads, namespace isolation |
| Human Developer | Safe IDE context, procedural skill docs, guardrails | File edits, slash commands, MCP tool calls | Helpful context and predictable conventions |
| Human Operator | One-command bootstrap, re-indexing, health checks | CLI and HTTP requests | Clear feedback, no silent failure |
| Runner | PRD files, skill registry, namespace corpus, memory service | Local filesystem and service calls | Reliable storage and fast retrieval |

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | AI Agent must be able to load project context for a namespace and task type without irrelevant sections. | MUST |
| FR-02 | AI Agent must be able to search project documents using natural language and receive ranked chunks. | MUST |
| FR-03 | AI Agent must be able to load a complete skill document by name without chunking. | MUST |
| FR-04 | AI Agent must be able to list available skills for discovery. | MUST |
| FR-05 | AI Agent must be able to persist decisions and summaries across sessions with a consistent naming convention. | MUST |
| FR-06 | AI Agent must be able to read prior decisions at session start to avoid contradictory choices. | MUST |
| FR-07 | Human Operator must be able to create a new project with a single command that creates required directories and PRD files. | MUST |
| FR-08 | Human Operator must be able to re-index a namespace after adding documents without restarting the system. | MUST |
| FR-09 | Human Developer must be able to load skills into IDE context automatically when relevant. | SHOULD |
| FR-10 | The system must support multiple projects with isolated namespaces so project data does not leak. | MUST |
| FR-11 | AI Agent must be able to list available projects from the runner filesystem. | SHOULD |
| FR-12 | The runtime skill registry must point at whole-doc `.agents/skills/*/SKILL.md` sources rather than chunked RAG fragments. | MUST |
| FR-13 | Local and remote memory write/read behavior must preserve the same JSON shape for stored values. | MUST |
| FR-14 | Project bootstrap must be idempotent and skip existing files without overwriting. | MUST |

## Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Performance | `rag_search` < 500ms typical, `memory_read` < 50ms, `load_skill` < 100ms, `get_project_context` < 200ms |
| NFR-02 | Reliability | Missing files are omitted, empty collections return `[]`, missing skills return available skills |
| NFR-03 | Maintainability | No duplicate MCP server implementation, tool handlers are separable, no dead code paths in the canonical runner |
| NFR-04 | Operability | Bootstrap is a single command, health is a single endpoint, configuration is env-driven |
| NFR-05 | Compatibility | MCP uses JSON-RPC 2.0 and streamable HTTP; Bun 1.3+, ChromaDB 1.5+, Postgres 16+ |

## Acceptance Criteria

| FR | Scenario | Expected result |
|---|---|---|
| FR-01 | Call `get_project_context("general", "demo")` after bootstrap | Returns project meta/goals JSON for `demo` |
| FR-02 | Call `rag_search("project setup", "demo")` | Returns ranked chunks from the `demo` namespace |
| FR-03 | Call `load_skill("hook-development")` | Returns the full skill document as one string |
| FR-04 | Call `list_skills()` | Returns registered skill names and descriptions |
| FR-05 | Call `memory_write(scope="project", namespace="demo", key="decision_x", ...)` | Stored value is retrievable with the same JSON shape |
| FR-06 | Start a session and call `memory_read_all(scope="project", namespace="demo")` | Returns prior session entries before new work begins |
| FR-07 | Run `bun run scripts/setup-project.ts demo --name "Demo"` | Creates `memory/demo/` and all `memory/prd/demo:prd:*.json` files |
| FR-08 | Add docs to `memory/demo/` and refresh the namespace | Re-index succeeds without restarting services |
| FR-09 | Open the repo in Claude Code with the prompt guidance | Relevant skills are discoverable and loadable from the registry |
| FR-10 | Create `alpha` and `beta` namespaces with the same key names | Reads stay scoped to the correct namespace |
| FR-11 | Call `list_projects()` after creating `demo` | Returns `demo` and excludes `prd` and `skills` |
| FR-12 | Inspect the skill registry | Each entry points at a whole `.agents/skills/.../SKILL.md` source file |
| FR-13 | Write an object to memory in local and remote modes | Readback is shape-compatible in both modes |
| FR-14 | Run bootstrap twice for the same namespace | Second run skips existing files and still exits cleanly |
