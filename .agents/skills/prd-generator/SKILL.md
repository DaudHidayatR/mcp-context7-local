---
name: prd-generator
description: This skill should be used when the user asks to "generate a PRD", "create a PRD", "write a product requirements document", "fill in project requirements", "bootstrap project context", "define project goals", "document project architecture", "write SOPs", or "set up memory/prd files for a new project". Produces the five JSON files that `get_project_context` reads: meta, goals, architecture, constraints, and sops.
version: 0.1.0
---

# PRD Generator

Produce the five structured JSON files that back `get_project_context` for a project namespace. Each file maps to one section the runner loads for agents at session start.

## File Contract

Every project namespace requires exactly these files under `memory/prd/`:
memory/prd/<namespace>:prd:meta.json
memory/prd/<namespace>:prd:goals.json
memory/prd/<namespace>:prd:architecture.json
memory/prd/<namespace>:prd:constraints.json
memory/prd/<namespace>:prd:sops.json

Bootstrap stubs are created automatically by `scripts/setup-project.ts`. This skill fills them with real content.

## Generation Workflow

### Phase 1 — Context Gathering

Before writing any file, gather the following by asking the user or reading existing docs:

**Project identity** — name, namespace slug, team, repo, version
**Goals** — primary objective in one sentence, ordered milestone list
**Architecture** — overall pattern, named components, key paths, ADRs (3–7 titles)
**Constraints** — tech stack with versions, volume/mount requirements, namespace rules
**SOPs** — incident response steps (numbered), common operational commands, contacts

If information is unavailable, leave the placeholder value from the bootstrap script ("TODO", [], or {}). Never invent specifics.

### Phase 2 — Draft Each File

Produce files in this order: meta → goals → architecture → constraints → sops.

For each file:
1. Read the existing stub if it exists
2. Merge new content, preserving fields the user already filled
3. Write valid JSON only — no comments, no trailing commas

See `references/prd-schema.md` for exact field shapes and `references/interview-guide.md` for question patterns.

### Phase 3 — Write Files

Write each file using the Write tool to `memory/prd/<namespace>:prd:<section>.json`.

After all five files are written, trigger namespace re-index:
POST http://127.0.0.1:3200/refresh-namespace {"namespace": "<namespace>"}

If the runner is not running locally, skip the refresh and remind the user.

### Phase 4 — Verification

Call get_project_context("general", "<namespace>") and confirm meta and goals sections appear.

## Section Summaries

| Section | Key Fields | Task types that load it |
|---------|-----------|------------------------|
| meta | name, version, description, team, repo | all |
| goals | primary, milestones | feature_dev, general |
| architecture | pattern, components, agent_tools, key_paths, adrs | feature_dev |
| constraints | tech, volume_requirements, namespace_rules | security_review, incident |
| sops | incident_response, common_ops, contacts | security_review, incident |

## Namespace Rules

- Must match `^[a-z0-9-]+$`, 3–40 characters
- Reserved system directories: `prd`, `skills`
- Bootstrap first: `bun run scripts/setup-project.ts <namespace> --name "Display Name"`

## Quality Checks

Before finishing:
- [ ] All five files are valid JSON
- [ ] Namespace slug in file names matches exactly
- [ ] meta.name is the human-readable display name, not the slug
- [ ] goals.primary is a single complete sentence
- [ ] architecture.adrs has no more than 7 items (runner truncates to 5 on load)
- [ ] sops.incident_response is a numbered step sequence, not a paragraph
- [ ] No TODO remains in fields the user provided answers for

## Additional Resources

- `references/prd-schema.md` — exact JSON shapes for all five sections
- `references/interview-guide.md` — question patterns to elicit each field
