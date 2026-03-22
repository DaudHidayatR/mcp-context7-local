import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const loadSkillArgsSchema = z.object({
  skill_name: z.string().min(1),
});

export interface SkillSummary {
  description: string;
  name: string;
}

interface SkillFileEntry extends SkillSummary {
  filePath: string;
  skillName: string;
}

const skillRegistrySchema = z.object({
  skills: z.array(z.object({
    description: z.string(),
    name: z.string(),
    source_path: z.string(),
  })),
});

function normalizeSkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
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
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());
    values[key] = value;
  }

  return values;
}

async function collectSkillsFromDirectory(skillsDir: string): Promise<SkillFileEntry[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: SkillFileEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const filePath = join(skillsDir, entry.name, "SKILL.md");
      try {
        const content = await readFile(filePath, "utf8");
        const frontmatter = parseFrontmatter(content);
        const skillName = normalizeSkillName(entry.name);
        skills.push({
          description: frontmatter.description ?? "",
          filePath,
          name: skillName,
          skillName,
        });
      } catch {
        // ignore non-skill directories
      }
    }

    return skills.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function collectSkillsFromRegistry(repoRoot: string): Promise<SkillFileEntry[]> {
  const registryPath = join(repoRoot, "memory", "skills", "index.json");

  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = skillRegistrySchema.parse(JSON.parse(raw));

    return parsed.skills
      .map((skill) => ({
        description: skill.description,
        filePath: join(repoRoot, skill.source_path),
        name: normalizeSkillName(skill.name),
        skillName: normalizeSkillName(skill.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

async function collectSkills(repoRoot: string): Promise<SkillFileEntry[]> {
  const registeredSkills = await collectSkillsFromRegistry(repoRoot);
  if (registeredSkills.length > 0) {
    return registeredSkills;
  }

  return collectSkillsFromDirectory(join(repoRoot, ".agents", "skills"));
}

function findSkill(skills: SkillFileEntry[], skillName: string): SkillFileEntry | undefined {
  const normalized = normalizeSkillName(skillName);
  return skills.find((skill) => skill.skillName === normalized);
}

export async function handleListSkills(repoRoot: string): Promise<{ skills: SkillSummary[] }> {
  const skills = await collectSkills(repoRoot);
  return {
    skills: skills.map(({ description, name }) => ({ description, name })),
  };
}

export async function handleLoadSkill(
  args: unknown,
  repoRoot: string,
): Promise<
  | { content: string; loaded_at: string; skill_name: string }
  | { available_skills: SkillSummary[]; error: string }
> {
  const { skill_name } = loadSkillArgsSchema.parse(args ?? {});
  const skills = await collectSkills(repoRoot);
  const skill = findSkill(skills, skill_name);

  if (!skill) {
    return {
      available_skills: skills.map(({ description, name }) => ({ description, name })),
      error: `Skill not found: ${skill_name}`,
    };
  }

  const content = await readFile(skill.filePath, "utf8");
  return {
    content,
    loaded_at: new Date().toISOString(),
    skill_name: skill.skillName,
  };
}
