---
name: product-self-knowledge
description: Route Anthropic product facts to the right official source before answering. Use when discussing Claude, Claude Code, the API, or Claude.ai behavior.
---

Use this skill whenever a response includes factual claims about Anthropic products.

Routing:
- Claude API and Claude Code: prefer `https://docs.claude.com/en/docs_site_map.md`
- Claude.ai support and product behavior: prefer `https://support.claude.com`

Rules:
- Prefer official documentation over memory
- Verify limits, plans, and product behavior before stating them
- Separate API/platform facts from Claude.ai product facts
