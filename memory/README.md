# Memory Corpus

This directory is mounted into the runner and indexed into Chroma.

## Layout

- `memory/<namespace>/` contains namespace documents that are synced into the RAG corpus
- `memory/prd/` contains project context JSON files used by `get_project_context`
- `memory/skills/` contains the runtime skill registry used by `list_skills` and `load_skill`

## PRD Files

The project context contract expects these files for each namespace:

- `memory/prd/<namespace>:prd:meta.json`
- `memory/prd/<namespace>:prd:goals.json`
- `memory/prd/<namespace>:prd:architecture.json`
- `memory/prd/<namespace>:prd:constraints.json`
- `memory/prd/<namespace>:prd:sops.json`

Missing files are treated as absent context sections.

## Skills Registry

The runtime skill registry is separate from the RAG corpus. Registry entries point at whole-document sources under `.agents/skills/*/SKILL.md` so skills can be loaded without chunking.
