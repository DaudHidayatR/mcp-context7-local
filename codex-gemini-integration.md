# Codex CLI <-> Gemini CLI Integration Plan

## Purpose

This document proposes a concrete design for letting the Codex CLI invoke and use the Gemini CLI as either:

1. A bounded tool for single-purpose tasks
2. A delegated subagent for longer-running or multi-step work

The design intentionally mirrors the subprocess-driven pattern already used in this repository, where a supervising process spawns the `codex` CLI and exchanges data through standard I/O. See [apps/runner/src/index.ts](/home/sagash/Documents/ai-tools-management/mcp-context7-local/apps/runner/src/index.ts#L91) for the current precedent.

## Assumptions

- Codex CLI is the primary orchestrator.
- Gemini CLI is locally installed and callable from the shell.
- Gemini CLI may or may not expose a stable machine-readable mode; the integration must therefore tolerate both structured and unstructured output.
- The goal is local process orchestration first, not remote API coupling.
- Codex should retain final control over permissions, filesystem scope, and user-visible output.

If Gemini CLI later exposes a stable JSON event protocol, the design below can simplify by removing the wrapper normalization layer.

## Goals

- Let Codex call Gemini for narrow tool-like tasks with low overhead.
- Let Codex delegate larger tasks to Gemini as a supervised subagent.
- Keep the integration transport simple: local subprocess plus stdin/stdout/stderr.
- Preserve Codex as the policy owner for approvals, sandboxing, and final synthesis.
- Make the Gemini side replaceable behind a stable internal adapter.

## Non-Goals

- Re-implement Gemini inside Codex.
- Depend on Gemini internals that are not externally stable.
- Give Gemini unrestricted direct access to Codex tool APIs without mediation.
- Build a distributed multi-host orchestration system in phase 1.

## Recommended Architecture

Use a three-layer design:

1. `GeminiProvider`
   - Codex-facing interface for starting tool runs and subagent runs.
   - Owns lifecycle, timeouts, retries, and normalization.
2. `gemini-bridge`
   - Thin local wrapper around the Gemini CLI.
   - Converts Codex requests into Gemini-compatible prompts and converts Gemini output into a predictable result envelope.
3. `Gemini CLI`
   - Actual execution engine.
   - Treated as an external dependency, not a trusted internal module.

This keeps Codex insulated from Gemini CLI flag changes and output drift.

## Operating Modes

### 1. Tool Mode

Use when Codex wants Gemini to perform one bounded task and return a result only.

Examples:

- Summarize a large diff
- Classify a log bundle
- Draft a migration plan
- Produce structured JSON from a chunk of text

Expected properties:

- Single prompt
- Short timeout
- No persistent session required
- No direct filesystem mutation unless explicitly enabled

### 2. Subagent Mode

Use when Codex wants Gemini to work semi-autonomously on a scoped task.

Examples:

- Explore a codebase area and report findings
- Produce an implementation proposal
- Modify files within an assigned directory
- Run a verification loop and summarize failures

Expected properties:

- Dedicated working directory or explicit write scope
- Longer timeout
- Streaming progress events
- Structured final report
- Optional handoff artifacts such as patch files or task logs

### 3. Interactive Relay Mode

This is optional and should not be phase 1. In this mode, Codex maintains a longer-lived Gemini session and forwards incremental messages. It is useful only if Gemini CLI supports robust session continuation semantics.

## Control Model

Codex remains the supervisor.

Gemini is never called directly by the user-facing flow. Instead:

1. User asks Codex to do work.
2. Codex decides whether Gemini is appropriate.
3. Codex packages context, constraints, and expected output schema.
4. Codex invokes the Gemini bridge.
5. Gemini returns a normalized result.
6. Codex validates the result and either:
   - Uses it as tool output
   - Integrates it into a larger workflow
   - Rejects and retries with a tighter prompt

This matches the same general orchestration principle already visible in the repo's runner, where a parent process spawns a CLI child and treats its stdout as the model result.

## Integration Surface Inside Codex

Codex should define a provider interface instead of hardcoding Gemini process calls in command handlers.

```ts
type AgentExecutionMode = "tool" | "subagent";

interface ExternalAgentRequest {
  mode: AgentExecutionMode;
  task: string;
  workingDirectory?: string;
  writeScope?: string[];
  readScope?: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  contextFiles?: string[];
  expectedSchema?: object;
  allowEdits?: boolean;
  metadata?: Record<string, string>;
}

interface ExternalAgentResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  structured?: unknown;
  artifacts?: string[];
  summary?: string;
  usage?: {
    durationMs: number;
  };
}

interface ExternalAgentProvider {
  name: string;
  execute(request: ExternalAgentRequest): Promise<ExternalAgentResult>;
}
```

The Codex CLI should register Gemini behind this interface exactly the same way it could later register other CLIs.

## Gemini Bridge Design

Create a small executable wrapper, for example:

- `scripts/gemini-bridge.ts`
- or `bin/codex-gemini-bridge`

Responsibilities:

- Accept a normalized JSON request from Codex
- Build the Gemini CLI invocation
- Inject a strict response contract into the prompt
- Capture stdout/stderr
- Parse the response into a stable JSON envelope
- Write final output to stdout in a machine-readable form

Recommended invocation shape:

```bash
codex-gemini-bridge run --request /tmp/request.json
```

Or via stdin:

```bash
codex-gemini-bridge run < request.json
```

The bridge should be the only place that knows Gemini CLI flags.

## Response Contract

To survive CLI output drift, Codex should not depend on Gemini's raw stdout format. The bridge should enforce a result envelope like this:

```json
{
  "ok": true,
  "summary": "Short human-readable summary",
  "structured": {
    "answer": "Primary result"
  },
  "artifacts": [],
  "stderr": "",
  "rawText": "Full Gemini response"
}
```

If Gemini cannot emit JSON natively, the bridge should prompt it to emit a final fenced JSON block with a sentinel marker:

```text
BEGIN_CODEX_RESULT
{ ...json... }
END_CODEX_RESULT
```

The bridge then parses only that section and treats all other output as logs.

## Prompt Contract

Every Gemini invocation should receive:

1. Role
   - `You are operating as a tool for Codex`
   - or `You are operating as a delegated subagent for Codex`
2. Scope
   - Working directory
   - Allowed files
   - Disallowed actions
3. Expected output
   - Required JSON schema or required report sections
4. Failure rules
   - If blocked, return a structured blocker instead of improvising

Recommended wrapper prompt template:

```text
You are being invoked by Codex as an external agent.

Execution mode: {{mode}}
Working directory: {{workingDirectory}}
Allowed write scope: {{writeScope}}
Task:
{{task}}

Output requirements:
- Do not address the user directly.
- Return a concise summary.
- Return a machine-readable JSON result inside BEGIN_CODEX_RESULT / END_CODEX_RESULT.
- If you are blocked, return {"blocked": true, "reason": "..."}.
```

## Data Flow

### Tool Mode Flow

1. Codex builds `ExternalAgentRequest`.
2. Codex serializes request JSON to stdin or a temp file.
3. Codex starts `codex-gemini-bridge`.
4. Bridge starts Gemini CLI.
5. Gemini returns text.
6. Bridge extracts structured result.
7. Codex validates schema.
8. Codex continues the parent task.

### Subagent Mode Flow

1. Codex assigns a scoped task and working directory.
2. Codex starts bridge with `mode=subagent`.
3. Bridge starts Gemini CLI with stronger instructions for progress reporting and final handoff.
4. Gemini may:
   - Read files
   - Propose edits
   - Produce a patch
   - Write logs or artifacts in a designated temp directory
5. Bridge emits progress lines or structured events back to Codex.
6. Codex optionally streams short progress updates to the user.
7. Gemini exits with a structured final result.
8. Codex reviews and integrates the output.

## IPC Strategy

Use a layered fallback model.

### Preferred

- Parent to bridge: JSON over stdin
- Bridge to parent: JSON over stdout

This is simple, portable, and easy to test.

### Optional Enhancement

- JSON Lines event stream for progress:

```json
{"type":"status","message":"Scanning repository"}
{"type":"artifact","path":"/tmp/gemini-report.md"}
{"type":"result","ok":true,"summary":"Completed"}
```

Codex can read line-by-line and surface progress without waiting for process exit.

### Fallback

- Temp file request/response exchange if Gemini or the shell environment makes stdin handling unreliable.

## Filesystem Model

Codex must remain the policy owner for filesystem access.

Recommended rules:

- In tool mode, Gemini defaults to read-only unless `allowEdits=true`.
- In subagent mode, Gemini receives an explicit write scope.
- The bridge should refuse requests that omit a scope in edit-enabled mode.
- For edit tasks, prefer one dedicated work directory per run.
- For safer integration, Gemini can emit a patch file instead of writing directly.

Three rollout levels:

1. Read-only analysis only
2. Patch generation only
3. Direct file edits in an approved scope

Phase 1 should stop at level 1 or 2.

## Process Lifecycle

Each run should track:

- `runId`
- provider name
- mode
- cwd
- timeout
- start timestamp
- end timestamp
- exit code
- parse status
- artifact paths

Codex should kill the Gemini subprocess when:

- Timeout is exceeded
- The parent task is cancelled
- Gemini emits malformed output repeatedly
- Gemini attempts to operate outside the assigned scope

## Error Handling

Classify errors into stable categories:

- `binary_not_found`
- `startup_failed`
- `timeout`
- `bad_output`
- `schema_validation_failed`
- `scope_violation`
- `nonzero_exit`
- `user_cancelled`

Codex should convert these into actionable retry behavior.

Example policy:

- `bad_output`: retry once with stricter formatting instructions
- `timeout`: retry only if task is idempotent and smaller context can be used
- `binary_not_found`: disable Gemini provider and continue without it
- `scope_violation`: hard fail and report

## Security And Trust Boundaries

The Gemini CLI must be treated as partially trusted.

Required safeguards:

- Do not pass the full parent environment by default.
- Maintain an env allowlist.
- Strip secrets unless explicitly required.
- Set cwd explicitly.
- Validate artifact paths before consuming them.
- Reject outputs that instruct Codex to perform unsafe actions without normal approval flow.
- Log the exact bridge command used for auditability.

## Observability

Add structured logs on the Codex side:

```json
{
  "component": "external-agent",
  "provider": "gemini",
  "mode": "tool",
  "runId": "abc123",
  "cwd": "/repo",
  "durationMs": 1842,
  "exitCode": 0,
  "ok": true
}
```

Useful metrics:

- total Gemini invocations
- success rate
- mean duration
- parse failure rate
- retry rate
- average output size
- subagent completion rate

## Recommended Codex CLI Changes

### 1. Add a Provider Registry

Introduce an internal provider registry so Codex can choose between:

- built-in/default execution
- Gemini tool provider
- Gemini subagent provider

### 2. Add an External Agent Adapter Layer

New module suggestion:

- `src/external-agents/types.ts`
- `src/external-agents/gemini.ts`
- `src/external-agents/bridge-client.ts`
- `src/external-agents/policy.ts`

### 3. Add a Bridge Process

New executable suggestion:

- `scripts/gemini-bridge.ts`

### 4. Add Routing Logic

Codex needs heuristics or explicit user commands to select Gemini.

Possible triggers:

- User explicitly asks to delegate to Gemini
- Task is exploratory and parallelizable
- Task benefits from an independent second model
- Task should be isolated from the main Codex context window

### 5. Add Result Validation

If the request includes `expectedSchema`, validate Gemini output before accepting it.

Use `zod` or the equivalent validation layer.

## Recommended Routing Policy

Start with explicit routing, not automatic routing.

Examples:

- `codex ask-gemini "summarize this trace"`
- `codex delegate gemini --task "..."`
- internal commands such as `useExternalAgent("gemini", request)`

After the provider proves reliable, Codex can auto-route selected task classes.

## Suggested CLI UX

### Tool Invocation

```bash
codex gemini tool --task "Summarize the failure mode in logs/app.log"
```

### Subagent Invocation

```bash
codex gemini delegate \
  --cwd /repo \
  --write-scope src/auth \
  --task "Investigate failing auth tests and propose a patch"
```

### JSON Invocation

```bash
codex gemini tool --json-request request.json
```

Internally, these commands should still go through the same provider interface used by the rest of Codex.

## Bridge Implementation Details

The bridge should support three output parsing modes, in this order:

1. Native Gemini JSON mode if available
2. Sentinel-delimited JSON block extraction
3. Plain-text fallback with `structured=null`

The bridge should never silently fabricate structured data from ambiguous free text.

Minimal bridge logic:

1. Read request
2. Validate request
3. Construct Gemini prompt
4. Spawn Gemini CLI
5. Stream stderr through for debugging
6. Capture stdout
7. Parse structured result
8. Emit normalized JSON
9. Exit nonzero on transport or validation failure

## Subagent Collaboration Pattern

For delegated work, use a supervisor-worker model:

1. Codex defines ownership boundaries.
2. Gemini works only within that boundary.
3. Gemini returns one of:
   - findings report
   - patch file
   - edited files plus summary
   - blocker report
4. Codex reviews before presenting or committing the result.

This mirrors the same collaborative constraint already used by Codex subagents: bounded scope, explicit ownership, and no uncontrolled direct user interaction.

## Compatibility Strategy

Because Gemini CLI behavior may vary across versions, add a provider capability probe:

```ts
interface GeminiCapabilities {
  binaryFound: boolean;
  supportsJsonMode: boolean;
  supportsSessionMode: boolean;
  version?: string;
}
```

On startup or first use:

1. Detect the binary
2. Probe `--version`
3. Probe JSON-capable invocation if supported
4. Cache capabilities for the session

Codex should degrade gracefully to plain subprocess usage if advanced features are unavailable.

## Testing Strategy

### Unit Tests

- request validation
- prompt construction
- sentinel extraction
- JSON schema validation
- scope enforcement
- error classification

### Integration Tests

Use a fake Gemini executable that:

- echoes valid structured output
- emits malformed JSON
- times out
- exits nonzero
- writes artifacts

This is the same testing pattern already used in the repo for fake stdio-backed MCP behavior.

### End-To-End Tests

Cover:

1. Tool mode success
2. Tool mode malformed output
3. Subagent mode with patch artifact
4. Subagent timeout
5. Missing Gemini binary

## Rollout Plan

### Phase 1: Read-Only Tool Mode

- Add provider interface
- Add Gemini bridge
- Support bounded prompts
- Return text plus optional structured JSON
- No direct edits

### Phase 2: Read-Only Subagent Mode

- Add longer-running delegated tasks
- Add progress events
- Add artifact directory support
- Keep file writes disabled

### Phase 3: Patch Handoff

- Allow Gemini to produce unified diffs or patch files
- Codex validates and optionally applies them

### Phase 4: Scoped Direct Edits

- Allow Gemini to edit within an approved boundary
- Add stricter audit logs and rollback-friendly behavior

## Recommended First Implementation

The first usable version should be intentionally narrow:

- one `GeminiProvider`
- one bridge executable
- one `tool` mode
- stdin request, stdout JSON response
- read-only operation
- strict timeout
- fake Gemini integration tests

That gets the process model, parsing layer, and policy boundary correct before adding autonomous behavior.

## Open Questions

- Does Gemini CLI expose a supported machine-readable mode?
- Does Gemini CLI support session continuation that is stable enough for interactive relay mode?
- Should Gemini write files directly, or should all edits flow back as patches?
- Should Codex auto-route to Gemini at all, or remain opt-in only?
- How much of the user prompt should be forwarded verbatim versus rewritten into a tool contract?

## Summary

The safest and cleanest approach is to integrate Gemini CLI behind a provider and bridge layer, using local subprocess execution and a strict response envelope. Codex remains the supervisor, Gemini remains replaceable, and the integration can start with low-risk read-only tool execution before expanding into scoped subagent behavior.
