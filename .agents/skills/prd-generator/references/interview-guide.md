# PRD Interview Guide

## Opening Questions

1. What is the project name and what namespace slug should be used?
2. Which team owns it, and what repo should be referenced if any?

## Per-Section Questions

### `meta`

| Field | Question to ask |
| --- | --- |
| `name` | What is the human-readable project name? |
| `version` | What version should the PRD start with? |
| `description` | What one- or two-sentence description best explains the project? |
| `team` | Which team owns this project? |
| `repo` | What repository name or codebase should be linked? |

### `goals`

| Field | Question to ask |
| --- | --- |
| `primary` | What is the single primary outcome this project must achieve? |
| `milestones` | What are the main milestones, in order? |

### `architecture`

| Field | Question to ask |
| --- | --- |
| `pattern` | What is the high-level architecture or operating pattern? |
| `components` | What are the main components and what does each one do? |
| `agent_tools` | Which agent tools are expected to matter for this project? |
| `key_paths` | Which files, directories, or registries should be called out as key paths? |
| `adrs` | What are the most important architecture decisions and their titles? |

### `constraints`

| Field | Question to ask |
| --- | --- |
| `tech` | What tech stack and version constraints apply? |
| `volume_requirements` | What mounts, storage, or filesystem requirements must be preserved? |
| `namespace_rules` | What namespace rules or bootstrap rules must users follow? |
| `requirements` | If the richer fields are unknown, what minimal requirements should still be recorded? |

### `sops`

| Field | Question to ask |
| --- | --- |
| `incident_response` | What numbered incident-response steps should operators follow first? |
| `common_ops` | What routine operations should be documented as command snippets? |
| `contacts` | Which docs, teams, or owners should be listed as contacts? |

## When The User Cannot Answer

- Keep the bootstrap placeholder value when the field is unknown.
- Accept `"TODO"` for required string placeholders.
- Accept `[]` for unknown list fields.
- Accept `{}` for unknown object fields.
- Do not invent teams, repos, commands, architecture decisions, or contacts.

## Minimal Interview (5 minutes)

1. What is the project name and namespace slug?
2. What is the primary goal in one sentence?
3. What are the top 3 milestones?
4. What are the main components or architecture pattern?
5. What incident steps or key operating commands must be documented right away?
