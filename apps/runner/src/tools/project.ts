import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const SYSTEM_MEMORY_DIRS = new Set(["prd", "skills"]);

const taskTypeSchema = z.enum(["feature_dev", "security_review", "incident", "general"]);

const getProjectContextArgsSchema = z.object({
  namespace: z.string(),
  task_type: taskTypeSchema,
});

export type RunnerTaskType = z.infer<typeof taskTypeSchema>;

interface CachedJsonEntry {
  mtimeMs: number;
  value: unknown | null;
}

export class ProjectContextCache {
  private readonly entries = new Map<string, CachedJsonEntry>();

  constructor(private readonly maxEntries = 128) {}

  clear(): void {
    this.entries.clear();
  }

  async readJson(filePath: string): Promise<unknown | null> {
    try {
      const info = await stat(filePath);
      const cached = this.entries.get(filePath);
      if (cached && cached.mtimeMs === info.mtimeMs) {
        return cached.value;
      }

      const raw = await readFile(filePath, "utf8");
      const value = JSON.parse(raw);
      this.set(filePath, { mtimeMs: info.mtimeMs, value });
      return value;
    } catch {
      this.entries.delete(filePath);
      return null;
    }
  }

  private set(filePath: string, entry: CachedJsonEntry): void {
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}

const TASK_TYPE_SECTIONS: Record<RunnerTaskType, string[]> = {
  feature_dev: ["meta", "goals", "architecture"],
  security_review: ["meta", "constraints", "sops"],
  incident: ["meta", "sops", "constraints"],
  general: ["meta", "goals"],
};

async function safeReadJsonFile(filePath: string, cache?: ProjectContextCache): Promise<unknown | null> {
  if (cache) {
    return cache.readJson(filePath);
  }

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadProjectContext(
  prdDir: string,
  taskType: RunnerTaskType,
  namespace: string,
  cache?: ProjectContextCache,
): Promise<Record<string, unknown>> {
  const sections = TASK_TYPE_SECTIONS[taskType];
  const context: Record<string, unknown> = {};

  for (const section of sections) {
    const filePath = join(prdDir, `${namespace}:prd:${section}.json`);
    const value = await safeReadJsonFile(filePath, cache);
    if (value !== null) {
      context[section] = value;
    }
  }

  return context;
}

export async function handleGetProjectContext(
  args: unknown,
  prdDir: string,
  cache?: ProjectContextCache,
): Promise<{ project_context: Record<string, unknown> }> {
  const { task_type, namespace } = getProjectContextArgsSchema.parse(args ?? {});
  const context = await loadProjectContext(prdDir, task_type, namespace, cache);
  return { project_context: context };
}

export async function handleListProjects(memoryRoot: string): Promise<{ projects: string[] }> {
  try {
    const entries = await readdir(memoryRoot, { withFileTypes: true });
    const projects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !SYSTEM_MEMORY_DIRS.has(name) && !name.startsWith("."))
      .sort((left, right) => left.localeCompare(right));

    return { projects };
  } catch {
    return { projects: [] };
  }
}
