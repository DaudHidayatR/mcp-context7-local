# Implementation Plan

## Overview

This plan is the next code pass after the docs and registry changes in this branch. The work is sequenced so that infrastructure and shared contracts land before feature work that depends on them.

## Work Breakdown

| Task | Goal | Depends on |
|---|---|---|
| TASK-01 | Remove duplicate runner MCP implementation or wire the canonical one. | None |
| TASK-02 | Separate tool handlers into `apps/runner/src/tools/`. | TASK-01 |
| TASK-03 | Add `load_skill` and `list_skills` from the skill registry. | TASK-02 |
| TASK-04 | Add `list_projects` for filesystem discovery. | TASK-02 |
| TASK-05 | Create `scripts/setup-project.ts` and make `create-project.ts` a wrapper. | None |
| TASK-06 | Add the PRD bootstrap files under `memory/prd/`. | TASK-05 |
| TASK-07 | Add `memory/skills/index.json` and keep it aligned with `.agents/skills`. | None |
| TASK-08 | Update the agent system prompt and README to document the new contract. | TASK-03, TASK-05, TASK-07 |
| TASK-09 | Add focused tests for tool handlers and project setup. | TASK-02, TASK-05 |
| TASK-10 | Run a full integration pass and verify the acceptance criteria. | TASK-03, TASK-05, TASK-07, TASK-09 |

## Suggested Order

1. Finish the runner MCP extraction.
2. Land the project bootstrap script and registry.
3. Update docs once the surface area is stable.
4. Verify the new contract with targeted tests and an integration pass.

## Acceptance Gates

- The runner MCP surface lists the new skill and project discovery tools.
- Project bootstrap is idempotent and does not overwrite existing files.
- The skill registry points at whole skill documents, not chunked corpus files.
- The docs explain the runner-first path without implying the legacy worker flow is canonical.
