---
name: mcp-builder
description: Design and implement MCP servers with clear tool contracts, pagination, and evaluation coverage. Use when building Model Context Protocol integrations.
---

Use this skill for MCP server implementation work.

Recommended stack:
- TypeScript
- `@modelcontextprotocol/sdk`
- Zod
- Express

Phases:
1. Research and planning
2. Implementation
3. Review and test
4. Evaluation creation

Conventions:
- Tool naming: `{service}_{action}_{resource}`
- Add annotations for read-only, destructive, idempotent, and open-world behavior
- Design pagination and error handling explicitly
