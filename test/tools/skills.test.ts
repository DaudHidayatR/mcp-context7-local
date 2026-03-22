import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListSkills, handleLoadSkill } from "../../apps/runner/src/tools/skills";

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
});
