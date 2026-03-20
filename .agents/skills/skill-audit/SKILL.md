---
name: skill-audit
description: Audit skill files for portability across AI agents and platforms. Use when classifying skills into general portable, vendor-specific portable, or platform/runtime specific tiers.
compatibility:
  tools: any AI agent that can read files and reason about them
  outputs: markdown reports and tables
---

# Skill Audit

Use this skill to classify any `SKILL.md` file by how portable it is across AI agents and platforms.

## Workflow

### Step 1: Read the full skill file

Read both the YAML frontmatter and the full body.

Do not classify based on the filename or folder path alone.

### Step 2: Check for platform lock-in signals

Scan for the following:

#### Hard lock-in (makes the skill non-portable)

- References to `.claude`, `CLAUDE.md`, or Claude Code plugins
- Mentions of slash commands, hooks, or plugin manifests
- Uses of Claude-specific APIs, tool names, or SDK methods
- Instructions that assume a specific agent runtime, such as spawning subagents or using a proprietary artifacts panel
- References to a specific proprietary UI, such as clicking feedback controls in a vendor product

#### Soft lock-in (reduces portability, but may still be usable elsewhere)

- Vendor-specific content such as Anthropic facts, brand voice, or proprietary product details
- Instructions that assume a specific model capability, such as an unusually large context window
- Policy defaults that are opinionated but not universal, such as always using React
- Wording that assumes the agent identity, such as "Claude is capable of..." or "As Claude, you should..."

#### No lock-in (fully portable)

- Task-oriented instructions that describe what to do instead of which agent does it
- Stack-agnostic or format-agnostic output rules
- Compatibility notes that say "any agent" or name multiple platforms
- Workflow steps any capable agent can follow with standard reading, writing, and execution tools

### Step 3: Classify the skill

Assign one tier:

| Tier | Label | Meaning |
|------|-------|---------|
| 1 | General portable | No hard lock-in. Any capable AI agent can use the skill as written. |
| 2 | Vendor-specific portable | No runtime lock-in, but the content is specific to one vendor or product context. |
| 3 | Platform/runtime specific | Has hard lock-in and depends on the target platform or runtime. |

### Step 4: Report findings

For each skill, use this format:

```text
Skill: <name>
File: <path or filename>
Tier: <1 / 2 / 3>
Label: <General portable / Vendor-specific portable / Platform/runtime specific>
Confidence: <high / medium / low>

Lock-in signals found:
- <list each signal, or "none">

Soft policy defaults found:
- <list each one, or "none">

Summary: <1-2 sentences explaining the classification>

Recommended action: <keep as-is / keep with note / rewrite for portability / keep in platform-specific registry only>
```

### Step 5: Produce a summary table

After the individual reports, produce one summary table:

```markdown
| Skill Name | Tier | Label | Action |
|------------|------|-------|--------|
| ...        | ...  | ...   | ...    |
```

Sort by tier ascending, with Tier 1 first.

## Auditor Rules

- Do not assume a skill is portable just because it does not mention Claude by name. Check the workflow, assumptions, and required runtime behavior.
- Do not assume a skill is non-portable just because it lives in a Claude or Codex skills folder. Judge the content, not the location.
- If a skill is mostly portable but has one hard lock-in line, classify it as Tier 3 and call out the specific lock-in signal.
- If uncertain, lower confidence and explain why.
- Vendor-specific facts, voice, or brand guidance do not automatically make a skill Tier 3. Runtime dependencies are what make it platform-specific.

## Usage Modes

### Single file

Read one `SKILL.md`, audit it, and produce the per-skill report plus the summary table.

### Folder or registry

List all `SKILL.md` files under the target directory, read each one fully, audit each file, then output:

1. One report per file
2. One combined summary table sorted by Tier ascending

## Scope

This skill is intentionally platform-agnostic. It should work for skills from Claude, Codex, Gemini, or any other registry, as long as the files are readable.
