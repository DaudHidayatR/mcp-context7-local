# Technical Decisions

## Decision Summary

The approved direction is runner-first. The canonical MCP implementation stays in the Bun runner, the dead `mcp-server.ts` rewrite is not promoted, and the new skill/runtime bootstrap contracts are filesystem-based.

## Decisions

| ID | Decision | Why |
|---|---|---|
| DEC-01 | Keep the inline runner MCP runtime as canonical for now. | It is the live, tested path; promoting the dead rewrite would add migration risk without a clear payoff. |
| DEC-02 | Delete `apps/runner/src/mcp-server.ts` as dead code once the refactor lands. | It duplicates behavior and confuses the source of truth. |
| DEC-03 | Separate tool handlers into `apps/runner/src/tools/*`. | This makes each tool independently testable and keeps the runner file focused on transport. |
| DEC-04 | Add `load_skill`, `list_skills`, and `list_projects` to the runner MCP surface. | These are the missing discovery and whole-document access primitives. |
| DEC-05 | Back skills with `memory/skills/index.json` and `.agents/skills/*/SKILL.md` sources. | This preserves the rich procedural docs without chunking them into RAG fragments. |
| DEC-06 | Add `scripts/setup-project.ts` and keep `scripts/create-project.ts` as a wrapper. | This avoids breaking existing operator muscle memory while introducing the new canonical flow. |
| DEC-07 | Keep the worker/gateway split architecture documented as legacy remote-path material. | The local runner workflow is the primary path for this repo now. |
| DEC-08 | Preserve whole JSON values across local and remote memory writes. | Tool semantics should not depend on where the memory backend is hosted. |

## Consequences

- The runner becomes the single place to reason about local project context, memory, and skill discovery.
- Project setup becomes reproducible from the filesystem instead of relying on manual PRD file creation.
- The legacy worker path remains documented for remote deployments, but it no longer defines the default local workflow.
