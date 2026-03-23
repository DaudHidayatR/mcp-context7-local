# PRD Schema Reference

Use case-sensitive file names:

`<namespace>:prd:<section>.json`

Example:

`proj-alpha:prd:meta.json`

## Section Shapes

### `meta`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Human-readable project name, not the namespace slug |
| `version` | string | Project or PRD version |
| `description` | string | Short summary of the project |
| `team` | string | Owning team when known |
| `repo` | string | Repository name or identifier when known |

Example:

```json
{
  "name": "Project Alpha",
  "version": "0.1.0",
  "description": "Short summary.",
  "team": "platform",
  "repo": "project-alpha"
}
```

### `goals`

| Field | Type | Notes |
| --- | --- | --- |
| `primary` | string | Single complete sentence describing the main goal |
| `milestones` | string[] | Ordered milestone list |

Example:

```json
{
  "primary": "Provide a local runner-first MCP context platform for AI agents.",
  "milestones": [
    "Bootstrap the namespace",
    "Load project context",
    "Refresh the namespace index"
  ]
}
```

### `architecture`

| Field | Type | Notes |
| --- | --- | --- |
| `pattern` | string | High-level system pattern |
| `components` | string[] | Array of `"name — description"` strings |
| `agent_tools` | string[] | Runner tools relevant to the project |
| `key_paths` | object | Important path map |
| `adrs` | `{ "id": number, "title": string }[]` | Architectural decisions, max 7 items |

Example:

```json
{
  "pattern": "runner-first",
  "components": [
    "runner — Bun HTTP + MCP server",
    "chromadb — vector store for RAG"
  ],
  "agent_tools": [
    "get_project_context",
    "list_skills"
  ],
  "key_paths": {
    "prd_files": "memory/prd/<namespace>:prd:<section>.json"
  },
  "adrs": [
    {
      "id": 1,
      "title": "Use whole-document skills for PRD generation"
    }
  ]
}
```

### `constraints`

| Field | Type | Notes |
| --- | --- | --- |
| `tech` | string[] | Tech stack and version requirements |
| `volume_requirements` | string[] | Mounts, storage, and path requirements |
| `namespace_rules` | string[] | Namespace and bootstrap constraints |
| `requirements` | string[] | Minimal bootstrap-compatible fallback field written by `setup-project.ts` |

Example:

```json
{
  "tech": [
    "Bun 1.3+",
    "Postgres 16+"
  ],
  "volume_requirements": [
    "./memory mounted RW at /app/memory"
  ],
  "namespace_rules": [
    "Namespaces must match ^[a-z0-9-]+$"
  ]
}
```

### `sops`

| Field | Type | Notes |
| --- | --- | --- |
| `incident_response` | string | Numbered step string, not a paragraph |
| `common_ops` | object | Operation name to command |
| `contacts` | object | Named contact or document references |

Example:

```json
{
  "incident_response": "1. Check runner health. 2. Check logs. 3. Restart the runner.",
  "common_ops": {
    "refresh_namespace": "POST http://127.0.0.1:3200/refresh-namespace {\"namespace\":\"proj-alpha\"}"
  },
  "contacts": {
    "readme": "README.md"
  }
}
```

## Minimal Valid Set

These are the exact bootstrap stubs currently written by `scripts/setup-project.ts`.

### `meta`

```json
{
  "description": "TODO",
  "name": "Project Alpha",
  "version": "0.1.0"
}
```

### `goals`

```json
{
  "milestones": [],
  "primary": "TODO"
}
```

### `architecture`

```json
{
  "adrs": [],
  "components": []
}
```

### `constraints`

```json
{
  "requirements": []
}
```

### `sops`

```json
{
  "contacts": {},
  "incident_response": "TODO"
}
```
