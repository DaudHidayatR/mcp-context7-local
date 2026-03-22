# Gap Analysis

## File Assessment

| File | Does | Status | Gap |
|---|---|---|---|
| `apps/runner/src/index.ts` | Implements the live runner app, query endpoint, refresh endpoints, and inline MCP runtime. | PARTIAL | Works for current tools, but still mixes transport wiring, validation, memory storage, and tool logic in one file. |
| `apps/runner/src/mcp-server.ts` | Alternative `McpServer` rewrite with `registerTool()`. | DEAD | Not imported anywhere; duplicates canonical runtime behavior. |
| `scripts/create-project.ts` | Posts refresh and init memory data. | PARTIAL | Does not create `memory/<namespace>/` or `memory/prd/*.json` bootstrap files. |
| `test/create-project.test.ts` | Verifies the current create-project behavior. | PARTIAL | Locks in the incomplete bootstrap flow and does not cover file creation. |
| `docs/agent-system-prompt.md` | Session protocol for agents. | PARTIAL | Lacks `list_skills`, `load_skill`, `list_projects`, and a clear memory key convention. |
| `README.md` | Local platform overview and current MCP client config. | PARTIAL | Does not describe runner-first project bootstrap or the filesystem contracts. |
| `docs/split-architecture-README.md` | Historical worker/gateway split architecture. | PARTIAL | Conflicts with the runner-first narrative unless clearly marked legacy. |
| `memory/README.md` | Explains the memory corpus mount. | PARTIAL | Does not document `memory/prd/` or the runtime skill registry. |
| `packages/mcp-client/src/index.ts` | Transport-aware MCP client. | CORRECT | Stable and already covered by tests. |
| `packages/rag/src/index.ts` | Local Chroma-backed RAG service. | CORRECT WITH LIMITATION | Retrieval is deterministic hash-based rather than semantic. |
| `services/context7-gateway/src/*` | Gateway composition, HTTP wiring, and session management. | CORRECT | Stable and well tested. |
| `services/memory/main.go` | Postgres-backed memory service. | CORRECT | Stable and well tested. |
| `services/rag/main.go` | Go RAG proxy service. | CORRECT WITH LIMITATION | Behavior is resilient, but empty-result fallback can mask infra issues. |
| `worker/src/index.ts` | Cloudflare Worker tool router. | PARTIAL | Tool-call-only surface; not a full MCP server and not aligned with the runner workflow. |
| `worker/src/index.test.ts` | Smoke-style worker checks. | PARTIAL | Runs outside the standard Bun test harness. |
| `memory/skills/index.json` | Runtime skill registry. | MISSING | Needs to be added as a whole-document registry backed by `.agents/skills`. |
| `memory/prd/` | Project PRD storage. | MISSING | Needs to exist for filesystem-backed `get_project_context`. |

## Bugs

| Bug ID | Scenario | Actual behavior | Root cause |
|---|---|---|---|
| BUG-01 | Call `get_project_context("feature_dev", "any-namespace")` | Returns an empty context | PRD files are absent, so reads fall through to silent omission. |
| BUG-02 | Call `load_skill("hook-development")` | Tool is unavailable | No runtime skill tool or registry exists yet. |
| BUG-03 | Run `bun run scripts/create-project.ts my-app` | Only prints checklist output | Script never creates the filesystem bootstrap files. |
| BUG-04 | Promote `apps/runner/src/mcp-server.ts` | Zod schema typing is forced through `as any` | The dead rewrite still carries a Zod v3/v4 mismatch. |
| BUG-05 | Ask the agent to discover available skills | No skill discovery path exists | There is no `list_skills` tool or registry. |

## Architectural Problems

| Problem ID | Description | Impact |
|---|---|---|
| ARCH-01 | Duplicate MCP server implementations exist in the runner. | Tool changes can drift between live and dead code paths. |
| ARCH-02 | Tool handlers are embedded in one large switch. | Individual handlers are hard to test and reason about. |
| ARCH-03 | Runtime skills have no whole-document access path. | Procedural skill content is only available as disconnected docs. |
| ARCH-04 | The PRD bootstrap path does not exist. | `get_project_context` has no canonical source of truth. |
| ARCH-05 | The docs still mix runner-first and legacy split-architecture guidance. | Operators can follow the wrong setup path. |

## Requirement Status

| Req ID | Current status | Gap |
|---|---|---|
| FR-01 | BROKEN | PRD files are not bootstrapped. |
| FR-02 | CORRECT WITH LIMITATION | Search works, but retrieval quality is lexical rather than semantic. |
| FR-03 | MISSING | No whole-document skill loader exists. |
| FR-04 | MISSING | No skill listing tool exists. |
| FR-05 | CORRECT WITH LIMITATION | Memory persistence exists, but overwrite timestamps need consistency. |
| FR-06 | CORRECT | Prior memory is readable at session start. |
| FR-07 | BROKEN | Setup script does not create bootstrap files. |
| FR-08 | CORRECT | Namespace refresh already exists. |
| FR-09 | PARTIAL | Skills are present in `.agents/skills`, but not exposed through runtime tools. |
| FR-10 | CORRECT | Namespaces are isolated by collection / scope. |
| FR-11 | MISSING | No project listing tool exists. |
| FR-12 | MISSING | No registry exists to load whole skill docs. |
| FR-13 | PARTIAL | Local and remote value handling differs. |
| FR-14 | PARTIAL | Existing bootstrap behavior is not idempotent because the filesystem path does not exist. |
