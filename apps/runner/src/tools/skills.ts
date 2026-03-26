import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const loadSkillArgsSchema = z.object({
  skill_name: z.string().min(1),
});

const resolveSkillArgsSchema = z.object({
  task: z.string().min(1),
  top_k: z.number().int().min(1).max(5).optional().default(1),
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

interface SkillSearchDocument {
  bodySnippet: string;
  frontmatterDescription: string;
  frontmatterName: string;
  headings: string[];
}

interface ResolvedSkillCandidate extends SkillSummary {
  matchedOn: string[];
  score: number;
}

interface ResolvedSkillResult {
  candidates: ResolvedSkillCandidate[];
  selected: ResolvedSkillCandidate;
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

function stripFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") {
    return content;
  }

  const endIndex = lines.indexOf("---", 1);
  if (endIndex < 0) {
    return content;
  }

  return lines.slice(endIndex + 1).join("\n");
}

function extractSearchText(content: string): SkillSearchDocument {
  const frontmatter = parseFrontmatter(content);
  const markdownBody = stripFrontmatter(content);
  const headings = markdownBody
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
      return match ? [match[1]] : [];
    });

  return {
    bodySnippet: markdownBody.slice(0, 8192),
    frontmatterDescription: frontmatter.description ?? "",
    frontmatterName: frontmatter.name ?? "",
    headings,
  };
}

function tokenize(value: string): string[] {
  return normalizeSkillName(value)
    .split("-")
    .filter(Boolean);
}

function countTokenOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function containsPhrase(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeSkillName(haystack);
  const normalizedNeedle = normalizeSkillName(needle);
  return normalizedNeedle.length >= 3 && normalizedHaystack.includes(normalizedNeedle);
}

function scoreSkillMatch(
  task: string,
  skill: SkillFileEntry,
  document?: SkillSearchDocument,
): { matchedOn: string[]; score: number; tieBreakNameHeading: number; tieBreakDescription: number } {
  const matchedOn = new Set<string>();
  const taskTokens = tokenize(task);
  const normalizedTask = normalizeSkillName(task);

  let score = 0;
  let tieBreakNameHeading = 0;
  let tieBreakDescription = 0;

  const registerMatch = (kind: string, amount: number, tieBucket?: "name-heading" | "description") => {
    if (amount <= 0) return;
    matchedOn.add(kind);
    score += amount;
    if (tieBucket === "name-heading") {
      tieBreakNameHeading += amount;
    }
    if (tieBucket === "description") {
      tieBreakDescription += amount;
    }
  };

  if (normalizedTask.includes(skill.skillName)) {
    registerMatch("name", 12, "name-heading");
  }

  const nameTokens = tokenize(skill.name);
  const nameOverlap = countTokenOverlap(taskTokens, nameTokens);
  registerMatch("name", nameOverlap * 4, "name-heading");

  const descriptionTokens = tokenize(skill.description);
  const descriptionOverlap = countTokenOverlap(taskTokens, descriptionTokens);
  registerMatch("description", descriptionOverlap * 3, "description");

  if (containsPhrase(task, skill.description)) {
    registerMatch("description", 4, "description");
  }

  if (document) {
    const frontmatterNameTokens = tokenize(document.frontmatterName);
    const frontmatterNameOverlap = countTokenOverlap(taskTokens, frontmatterNameTokens);
    registerMatch("name", frontmatterNameOverlap * 3, "name-heading");

    const frontmatterDescriptionTokens = tokenize(document.frontmatterDescription);
    const frontmatterDescriptionOverlap = countTokenOverlap(taskTokens, frontmatterDescriptionTokens);
    registerMatch("description", frontmatterDescriptionOverlap * 2, "description");

    const headingText = document.headings.join(" ");
    const headingTokens = tokenize(headingText);
    const headingOverlap = countTokenOverlap(taskTokens, headingTokens);
    registerMatch("headings", headingOverlap * 3, "name-heading");

    if (document.headings.some((heading) => containsPhrase(task, heading) || containsPhrase(heading, task))) {
      registerMatch("headings", 4, "name-heading");
    }

    const bodyTokens = tokenize(document.bodySnippet);
    const bodyOverlap = countTokenOverlap(taskTokens, bodyTokens);
    registerMatch("body", bodyOverlap, undefined);

    if (containsPhrase(document.bodySnippet, task)) {
      registerMatch("body", 2, undefined);
    }
  }

  return {
    matchedOn: [...matchedOn],
    score,
    tieBreakDescription,
    tieBreakNameHeading,
  };
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

async function findRelevantSkill(
  skills: SkillFileEntry[],
  task: string,
  cache?: SkillsCache,
  topK = 1,
): Promise<ResolvedSkillResult | null> {
  const candidates: Array<ResolvedSkillCandidate & {
    tieBreakDescription: number;
    tieBreakNameHeading: number;
  }> = [];

  for (const skill of skills) {
    const content = cache ? await cache.loadSkillContent(skill.filePath) : await readFile(skill.filePath, "utf8");
    const score = scoreSkillMatch(task, skill, extractSearchText(content));
    if (score.score <= 0) {
      continue;
    }

    candidates.push({
      description: skill.description,
      matchedOn: score.matchedOn,
      name: skill.name,
      score: score.score,
      tieBreakDescription: score.tieBreakDescription,
      tieBreakNameHeading: score.tieBreakNameHeading,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) =>
    right.score - left.score
    || right.tieBreakNameHeading - left.tieBreakNameHeading
    || right.tieBreakDescription - left.tieBreakDescription
    || left.name.localeCompare(right.name));

  return {
    candidates: candidates.slice(0, topK).map(({ tieBreakDescription, tieBreakNameHeading, ...candidate }) => candidate),
    selected: (({ tieBreakDescription, tieBreakNameHeading, ...candidate }) => candidate)(candidates[0]),
  };
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

export async function handleResolveSkill(
  args: unknown,
  repoRoot: string,
  cache?: SkillsCache,
): Promise<
  | {
    candidates: Array<{ description: string; name: string; score: number }>;
    content: string;
    loaded_at: string;
    match: { matched_on: string[]; score: number };
    skill_name: string;
  }
  | { available_skills: SkillSummary[]; error: string }
> {
  const { task, top_k } = resolveSkillArgsSchema.parse(args ?? {});
  const skills = await collectSkills(repoRoot, cache);
  const resolved = await findRelevantSkill(skills, task, cache, top_k);

  if (!resolved) {
    return {
      available_skills: skills.map(({ description, name }) => ({ description, name })),
      error: `No relevant skill found for task: ${task}`,
    };
  }

  const skill = findSkill(skills, resolved.selected.name);
  if (!skill) {
    return {
      available_skills: skills.map(({ description, name }) => ({ description, name })),
      error: `Skill not found: ${resolved.selected.name}`,
    };
  }

  const content = cache ? await cache.loadSkillContent(skill.filePath) : await readFile(skill.filePath, "utf8");
  return {
    candidates: resolved.candidates.map(({ description, name, score }) => ({ description, name, score })),
    content,
    loaded_at: new Date().toISOString(),
    match: {
      matched_on: resolved.selected.matchedOn,
      score: resolved.selected.score,
    },
    skill_name: skill.skillName,
  };
}
