import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { handleListSkills, handleLoadSkill, handleResolveSkill, SkillsCache } from "../../apps/runner/src/tools/skills";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
      tempDirs.delete(dir);
    }),
  );
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function normalizeSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return {};
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex < 0) {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

async function collectFiles(dir: string, base = dir): Promise<Array<{ full: string; rel: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ full: string; rel: string }> = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full, base));
      continue;
    }
    files.push({
      full,
      rel: full.slice(base.length + 1).replace(/\\/g, "/"),
    });
  }

  return files.sort((left, right) => left.rel.localeCompare(right.rel));
}

async function computeDirectoryHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await collectFiles(dir)) {
    hash.update(file.rel);
    hash.update("\n");
    hash.update(await readFile(file.full));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function writeSkill(
  repoRoot: string,
  directoryName: string,
  content: string,
): Promise<string> {
  const skillPath = join(repoRoot, ".agents", "skills", directoryName, "SKILL.md");
  await mkdir(join(repoRoot, ".agents", "skills", directoryName), { recursive: true });
  await writeFile(skillPath, content, "utf8");
  return skillPath;
}

describe("runner skills tools", () => {
  test("lists skills from the registry", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await mkdir(join(repoRoot, ".agents", "skills", "Hook Development"), { recursive: true });
    await writeFile(
      join(repoRoot, ".agents", "skills", "Hook Development", "SKILL.md"),
      [
        "---",
        "name: Hook Development",
        "description: Hook tooling",
        "---",
        "",
        "# Hook Development",
      ].join("\n"),
      "utf8",
    );

    await mkdir(join(repoRoot, ".agents", "skills", "MCP Integration"), { recursive: true });
    await writeFile(
      join(repoRoot, ".agents", "skills", "MCP Integration", "SKILL.md"),
      [
        "---",
        "name: MCP Integration",
        "description: MCP tooling",
        "---",
        "",
        "# MCP Integration",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
          {
            description: "MCP tooling",
            name: "mcp-integration",
            source_path: ".agents/skills/MCP Integration/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const result = await handleListSkills(repoRoot);

    expect(result).toEqual({
      skills: [
        { description: "Hook tooling", name: "hook-development" },
        { description: "MCP tooling", name: "mcp-integration" },
      ],
    });
  });

  test("loads a whole skill document and reports available skills on miss", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await mkdir(join(repoRoot, ".agents", "skills", "Hook Development"), { recursive: true });
    const skillContent = [
      "---",
      "name: Hook Development",
      "description: Hook tooling",
      "---",
      "",
      "# Hook Development",
      "",
      "This is the full document.",
    ].join("\n");

    await writeFile(join(repoRoot, ".agents", "skills", "Hook Development", "SKILL.md"), skillContent, "utf8");
    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const loaded = await handleLoadSkill({ skill_name: "hook-development" }, repoRoot);
    expect(loaded).toMatchObject({
      content: skillContent,
      skill_name: "hook-development",
    });
    expect(typeof (loaded as { loaded_at: string }).loaded_at).toBe("string");

    const missing = await handleLoadSkill({ skill_name: "missing-skill" }, repoRoot);
    expect(missing).toMatchObject({
      error: "Skill not found: missing-skill",
      available_skills: [{ description: "Hook tooling", name: "hook-development" }],
    });
  });

  test("invalidates cached registry and skill content when files change", async () => {
    const repoRoot = await createTempDir("runner-skills-");
    const cache = new SkillsCache();
    const registryPath = join(repoRoot, "memory", "skills", "index.json");
    const skillPath = join(repoRoot, ".agents", "skills", "Hook Development", "SKILL.md");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await mkdir(join(repoRoot, ".agents", "skills", "Hook Development"), { recursive: true });
    await writeFile(skillPath, "# Version 1\n", "utf8");
    await writeFile(
      registryPath,
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling v1",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const firstList = await handleListSkills(repoRoot, cache);
    const firstLoad = await handleLoadSkill({ skill_name: "hook-development" }, repoRoot, cache);

    await Bun.sleep(5);
    await writeFile(skillPath, "# Version 2\n", "utf8");
    await writeFile(
      registryPath,
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling v2",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const secondList = await handleListSkills(repoRoot, cache);
    const secondLoad = await handleLoadSkill({ skill_name: "hook-development" }, repoRoot, cache);

    expect(firstList).toEqual({
      skills: [{ description: "Hook tooling v1", name: "hook-development" }],
    });
    expect(firstLoad).toMatchObject({ content: "# Version 1\n" });
    expect(secondList).toEqual({
      skills: [{ description: "Hook tooling v2", name: "hook-development" }],
    });
    expect(secondLoad).toMatchObject({ content: "# Version 2\n" });
  });

  test("resolves the best skill from registry text and returns full content", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    const hookContent = [
      "---",
      "name: Hook Development",
      "description: Hook tooling",
      "---",
      "",
      "# Hook Development",
      "",
      "Build pre-tool and post-tool hooks.",
    ].join("\n");
    const commandContent = [
      "---",
      "name: Command Development",
      "description: Command tooling",
      "---",
      "",
      "# Command Development",
      "",
      "Build slash commands and arguments.",
    ].join("\n");

    await writeSkill(repoRoot, "Hook Development", hookContent);
    await writeSkill(repoRoot, "Command Development", commandContent);
    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "Create hooks for tool validation and automation.",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
          {
            description: "Create slash commands and arguments.",
            name: "command-development",
            source_path: ".agents/skills/Command Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const resolved = await handleResolveSkill(
      { task: "add a pre tool hook that blocks dangerous shell commands", top_k: 2 },
      repoRoot,
    );

    expect(resolved).toMatchObject({
      content: hookContent,
      skill_name: "hook-development",
      match: {
        matched_on: expect.arrayContaining(["description", "name"]),
      },
    });
    expect("candidates" in resolved && resolved.candidates).toEqual([
      expect.objectContaining({ name: "hook-development" }),
      expect.objectContaining({ name: "command-development" }),
    ]);
  });

  test("resolves a skill using headings when registry descriptions are insufficient", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await writeSkill(
      repoRoot,
      "Hook Development",
      [
        "---",
        "name: Hook Development",
        "description: Hook tooling",
        "---",
        "",
        "# PreToolUse Hook",
        "",
        "Block dangerous shell commands before execution.",
      ].join("\n"),
    );
    await writeSkill(
      repoRoot,
      "Command Development",
      [
        "---",
        "name: Command Development",
        "description: Command tooling",
        "---",
        "",
        "# Slash Commands",
        "",
        "Define arguments and interactive prompts.",
      ].join("\n"),
    );
    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "General workflow guidance",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
          {
            description: "General workflow guidance",
            name: "command-development",
            source_path: ".agents/skills/Command Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const resolved = await handleResolveSkill(
      { task: "implement a pretooluse hook for command blocking" },
      repoRoot,
    );

    expect(resolved).toMatchObject({
      skill_name: "hook-development",
      match: {
        matched_on: expect.arrayContaining(["headings"]),
      },
    });
  });

  test("returns available skills when no relevant skill is found", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await writeSkill(repoRoot, "Hook Development", "# Hook Development\n");
    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const resolved = await handleResolveSkill(
      { task: "spreadsheet pivot table accounting model" },
      repoRoot,
    );

    expect(resolved).toEqual({
      available_skills: [{ description: "Hook tooling", name: "hook-development" }],
      error: "No relevant skill found for task: spreadsheet pivot table accounting model",
    });
  });

  test("uses deterministic tie-breaking when scores are equal", async () => {
    const repoRoot = await createTempDir("runner-skills-");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    await writeSkill(repoRoot, "Alpha Skill", "# Alpha Skill\n");
    await writeSkill(repoRoot, "Beta Skill", "# Beta Skill\n");
    await writeFile(
      join(repoRoot, "memory", "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            description: "Shared workflow text",
            name: "beta-skill",
            source_path: ".agents/skills/Beta Skill/SKILL.md",
          },
          {
            description: "Shared workflow text",
            name: "alpha-skill",
            source_path: ".agents/skills/Alpha Skill/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const resolved = await handleResolveSkill(
      { task: "shared workflow text", top_k: 2 },
      repoRoot,
    );

    expect(resolved).toMatchObject({
      skill_name: "alpha-skill",
    });
    if (!("candidates" in resolved)) {
      throw new Error("expected candidates in resolve_skill result");
    }
    const [firstCandidate, secondCandidate] = resolved.candidates;
    expect(resolved.candidates).toEqual([
      expect.objectContaining({ name: "alpha-skill", score: firstCandidate.score }),
      expect.objectContaining({ name: "beta-skill", score: secondCandidate.score }),
    ]);
    expect(firstCandidate.score).toBe(secondCandidate.score);
  });

  test("invalidates cached resolution inputs when registry and skill content change", async () => {
    const repoRoot = await createTempDir("runner-skills-");
    const cache = new SkillsCache();
    const registryPath = join(repoRoot, "memory", "skills", "index.json");

    await mkdir(join(repoRoot, "memory", "skills"), { recursive: true });
    const hookPath = await writeSkill(
      repoRoot,
      "Hook Development",
      "# Hook Development\n\nBlock dangerous shell commands.\n",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        skills: [
          {
            description: "Hook tooling",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const firstResolved = await handleResolveSkill(
      { task: "dangerous shell commands" },
      repoRoot,
      cache,
    );

    await Bun.sleep(5);
    await writeFile(hookPath, "# Hook Development\n\nReview plugin manifests.\n", "utf8");
    await writeFile(
      registryPath,
      JSON.stringify({
        skills: [
          {
            description: "Plugin manifest guidance",
            name: "hook-development",
            source_path: ".agents/skills/Hook Development/SKILL.md",
          },
        ],
      }),
      "utf8",
    );

    const secondResolved = await handleResolveSkill(
      { task: "plugin manifest guidance" },
      repoRoot,
      cache,
    );

    expect(firstResolved).toMatchObject({ skill_name: "hook-development" });
    expect(secondResolved).toMatchObject({
      skill_name: "hook-development",
      content: "# Hook Development\n\nReview plugin manifests.\n",
    });
    expect("candidates" in secondResolved && secondResolved.candidates).toEqual([
      expect.objectContaining({
        description: "Plugin manifest guidance",
        name: "hook-development",
      }),
    ]);
  });

  test("repo registry stays aligned with local skills", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const registryPath = join(repoRoot, "memory", "skills", "index.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      skills: Array<{ description: string; load_mode: string; name: string; source_path: string }>;
    };

    const localSkillsDir = join(repoRoot, ".agents", "skills");
    const directories = await readdir(localSkillsDir, { withFileTypes: true });
    const localSkillPaths: string[] = [];

    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const relativeSkillPath = `.agents/skills/${entry.name}/SKILL.md`;
      const absoluteSkillPath = join(repoRoot, relativeSkillPath);
      try {
        await readFile(absoluteSkillPath, "utf8");
        localSkillPaths.push(relativeSkillPath);
      } catch {
        // ignore directories without a SKILL.md file
      }
    }

    const sortedLocalSkillPaths = [...localSkillPaths].sort();
    const registryPaths = registry.skills.map((skill) => skill.source_path).sort();
    expect(registryPaths).toEqual(sortedLocalSkillPaths);

    const registryNames = new Set<string>();
    for (const skill of registry.skills) {
      expect(skill.description.trim().length).toBeGreaterThan(0);
      expect(skill.load_mode).toBe("whole-document");
      expect(skill.name).toBe(normalizeSkillName(skill.name));
      expect(registryNames.has(skill.name)).toBeFalse();
      registryNames.add(skill.name);

      const content = await readFile(join(repoRoot, skill.source_path), "utf8");
      const frontmatter = parseFrontmatter(content);
      expect(normalizeSkillName(frontmatter.name ?? "")).toBe(skill.name);
      expect(frontmatter.description?.trim().length ?? 0).toBeGreaterThan(0);
      expect(frontmatter.description?.trim()).toBe(skill.description);
    }
  });

  test("repo lockfile stays aligned with local skills and source classifications", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const registry = JSON.parse(await readFile(join(repoRoot, "memory", "skills", "index.json"), "utf8")) as {
      skills: Array<{ name: string; source_path: string }>;
    };
    const lockfile = JSON.parse(await readFile(join(repoRoot, "skills-lock.json"), "utf8")) as {
      skills: Record<string, { computedHash: string; source: string; sourceType: string }>;
    };

    const registryNames = new Set(registry.skills.map((skill) => skill.name));
    expect(Object.keys(lockfile.skills).sort()).toEqual([...registryNames].sort());

    for (const skill of registry.skills) {
      const lockEntry = lockfile.skills[skill.name];
      expect(lockEntry).toBeDefined();
      expect(["github", "custom"]).toContain(lockEntry.sourceType);
      if (lockEntry.sourceType === "custom") {
        expect(lockEntry.source).toBe("local");
      }
      const skillDir = join(repoRoot, skill.source_path.replace(/\/SKILL\.md$/, ""));
      expect(await computeDirectoryHash(skillDir)).toBe(lockEntry.computedHash);
    }
  });

  test("requested and priority-matched skills are classified correctly", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const lockfile = JSON.parse(await readFile(join(repoRoot, "skills-lock.json"), "utf8")) as {
      skills: Record<string, { source: string; sourceType: string }>;
    };

    expect(lockfile.skills["brand-guidelines"]).toMatchObject({
      source: "anthropics/skills",
      sourceType: "github",
    });
    expect(lockfile.skills["canvas-design"]).toMatchObject({
      source: "anthropics/skills",
      sourceType: "github",
    });
    expect(lockfile.skills["command-development"]).toMatchObject({
      source: "anthropics/claude-code",
      sourceType: "github",
    });
    expect(lockfile.skills["doc-coauthoring"]).toMatchObject({
      source: "anthropics/skills",
      sourceType: "github",
    });
    expect(lockfile.skills["docx"]).toMatchObject({
      source: "anthropics/skills",
      sourceType: "github",
    });
    expect(lockfile.skills["find-skills"]).toMatchObject({
      source: "vercel-labs/skills",
      sourceType: "github",
    });
    expect(lockfile.skills["writing-hookify-rules"]).toMatchObject({
      source: "local",
      sourceType: "custom",
    });
  });

  test("repo runner tools expose newly registered local skills", async () => {
    const repoRoot = join(import.meta.dir, "../..");

    const listed = await handleListSkills(repoRoot);
    expect(listed.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "find-skills" }),
      expect.objectContaining({ name: "frontend-design" }),
      expect.objectContaining({ name: "pdf" }),
      expect.objectContaining({ name: "xlsx" }),
    ]));

    const loaded = await handleLoadSkill({ skill_name: "find-skills" }, repoRoot);
    expect(loaded).toMatchObject({
      skill_name: "find-skills",
    });
    expect("content" in loaded && loaded.content).toContain("npx skills find");

    const resolved = await handleResolveSkill(
      { task: "find a skill for react performance" },
      repoRoot,
    );
    expect(resolved).toMatchObject({
      skill_name: "find-skills",
    });
  });
});
