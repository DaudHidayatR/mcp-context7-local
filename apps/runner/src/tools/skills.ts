import { readdir, readFile, stat } from "node:fs/promises";
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

interface CachedRegistryEntry {
  mtimeMs: number;
  skills: SkillFileEntry[];
}

interface CachedSkillContentEntry {
  content: string;
  mtimeMs: number;
}

export class SkillsCache {
  private readonly contentEntries = new Map<string, CachedSkillContentEntry>();
  private registryEntry: CachedRegistryEntry | null = null;

  constructor(private readonly maxContentEntries = 64) {}

  clear(): void {
    this.registryEntry = null;
    this.contentEntries.clear();
  }

  async loadRegistry(registryPath: string, repoRoot: string): Promise<SkillFileEntry[] | null> {
    try {
      const info = await stat(registryPath);
      if (this.registryEntry && this.registryEntry.mtimeMs === info.mtimeMs) {
        return this.registryEntry.skills;
      }

      const raw = await readFile(registryPath, "utf8");
      const parsed = skillRegistrySchema.parse(JSON.parse(raw));
      const skills = parsed.skills
        .map((skill) => ({
          description: skill.description,
          filePath: join(repoRoot, skill.source_path),
          name: normalizeSkillName(skill.name),
          skillName: normalizeSkillName(skill.name),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      this.registryEntry = { mtimeMs: info.mtimeMs, skills };
      return skills;
    } catch {
      this.registryEntry = null;
      return null;
    }
  }

  async loadSkillContent(filePath: string): Promise<string> {
    const info = await stat(filePath);
    const cached = this.contentEntries.get(filePath);
    if (cached && cached.mtimeMs === info.mtimeMs) {
      return cached.content;
    }

    const content = await readFile(filePath, "utf8");
    this.setContent(filePath, { content, mtimeMs: info.mtimeMs });
    return content;
  }

  private setContent(filePath: string, entry: CachedSkillContentEntry): void {
    this.contentEntries.delete(filePath);
    this.contentEntries.set(filePath, entry);
    while (this.contentEntries.size > this.maxContentEntries) {
      const oldestKey = this.contentEntries.keys().next().value;
      if (!oldestKey) break;
      this.contentEntries.delete(oldestKey);
    }
  }
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

async function collectSkillsFromRegistry(repoRoot: string, cache?: SkillsCache): Promise<SkillFileEntry[]> {
  const registryPath = join(repoRoot, "memory", "skills", "index.json");

  if (cache) {
    const cached = await cache.loadRegistry(registryPath, repoRoot);
    if (cached) {
      return cached;
    }
  }

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

async function collectSkills(repoRoot: string, cache?: SkillsCache): Promise<SkillFileEntry[]> {
  const registeredSkills = await collectSkillsFromRegistry(repoRoot, cache);
  if (registeredSkills.length > 0) {
    return registeredSkills;
  }

  return collectSkillsFromDirectory(join(repoRoot, ".agents", "skills"));
}

function findSkill(skills: SkillFileEntry[], skillName: string): SkillFileEntry | undefined {
  const normalized = normalizeSkillName(skillName);
  return skills.find((skill) => skill.skillName === normalized);
}

export async function handleListSkills(repoRoot: string, cache?: SkillsCache): Promise<{ skills: SkillSummary[] }> {
  const skills = await collectSkills(repoRoot, cache);
  return {
    skills: skills.map(({ description, name }) => ({ description, name })),
  };
}

export async function handleLoadSkill(
  args: unknown,
  repoRoot: string,
  cache?: SkillsCache,
): Promise<
  | { content: string; loaded_at: string; skill_name: string }
  | { available_skills: SkillSummary[]; error: string }
> {
  const { skill_name } = loadSkillArgsSchema.parse(args ?? {});
  const skills = await collectSkills(repoRoot, cache);
  const skill = findSkill(skills, skill_name);

  if (!skill) {
    return {
      available_skills: skills.map(({ description, name }) => ({ description, name })),
      error: `Skill not found: ${skill_name}`,
    };
  }

  const content = cache ? await cache.loadSkillContent(skill.filePath) : await readFile(skill.filePath, "utf8");
  return {
    content,
    loaded_at: new Date().toISOString(),
    skill_name: skill.skillName,
  };
}
