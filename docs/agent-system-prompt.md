# Agent System Prompt — MCP Context Injection

> Add the following block to your agent's system prompt to enable automatic
> context loading, RAG-aware coding, and session-end memory persistence.

---

## MCP Endpoint

Connect your MCP client to one of:

- Local: `http://127.0.0.1:3200/mcp` (Docker stack)
- Remote: `https://<your-worker>.workers.dev` (Cloudflare)

The tool names and call patterns are identical on both endpoints.

## Context & Memory Protocol

You have access to the following MCP tools for project awareness and memory:

## Namespace Convention

- Namespace = the project slug
- Use lowercase hyphenated slugs such as `vulnportal`, not `VulnPortal`
- Valid namespaces match `^[a-z0-9-]+$`

### Session Start Sequence

At the **start of every session**, execute these steps in order:

1. **Load project context:**
   ```
   get_project_context(task_type, namespace="{project_slug}")
   ```
   Set `task_type` to one of:
   - `"feature_dev"` — when building new features or modifying existing ones
   - `"security_review"` — when auditing, reviewing, or hardening security
   - `"incident"` — when responding to outages, bugs, or production issues
   - `"general"` — for all other tasks (research, documentation, refactoring)
   Replace `{project_slug}` with your project's namespace, for example
   `"vulnportal"` or `"ssdlc-sim"`.

2. **Load prior decisions:**
   ```
   memory_read_all(scope="project", namespace="{project_slug}")
   ```
   This returns all stored decisions, changed files, and open questions
   from every previous session for this project, with `age_seconds` so
   you know how recent each entry is.

3. **Acknowledge context loaded** — briefly confirm what you learned from
   the project context and prior decisions before proceeding.

### Before Writing Code

**Never assume the codebase state.** Before writing or modifying any code
that touches existing files:

```
rag_search(query="{description of what you're about to change}", namespace="{project_slug}", top_k=5)
```

Use the returned context to:

- Understand current file structure and patterns
- Identify related code that may be affected
- Avoid duplicating existing functionality
- Respect established conventions

### Session End Sequence

Before ending **any** session, persist your work:

```
memory_write(
  scope="project",
  namespace="{project_slug}",
  key="session_{timestamp}",
  value={
    "decisions_made": ["list of key decisions"],
    "files_changed": ["list of files modified"],
    "open_questions": ["unresolved items for next session"],
    "summary": "brief description of what was accomplished"
  },
  tags=["session", "{task_type}"]
)
```

### Rules

- **Always RAG search first** — never assume you know the current state of
  the codebase. The code may have changed since your training data.
- **Always save decisions** — if you made a non-trivial choice (architecture,
  library selection, approach), persist it via `memory_write`.
- **Read before write** — always check `memory_read_all` for existing decisions
  on the same topic before making conflicting choices.
- **Context is scoped** — each project has its own namespace. Never mix
  context from different projects.
