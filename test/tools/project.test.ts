import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGetProjectContext, handleListProjects } from "../../apps/runner/src/tools/project";

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

describe("runner project tools", () => {
  test("loads readable PRD sections and skips missing or invalid ones", async () => {
    const prdDir = await createTempDir("runner-prd-");

    await writeFile(join(prdDir, "alpha:prd:meta.json"), JSON.stringify({ name: "Alpha" }), "utf8");
    await writeFile(join(prdDir, "alpha:prd:goals.json"), JSON.stringify({ primary: "Ship" }), "utf8");
    await writeFile(join(prdDir, "alpha:prd:architecture.json"), "{invalid-json", "utf8");

    const result = await handleGetProjectContext(
      { namespace: "alpha", task_type: "feature_dev" },
      prdDir,
    );

    expect(result).toEqual({
      project_context: {
        goals: { primary: "Ship" },
        meta: { name: "Alpha" },
      },
    });
    expect(result.project_context).not.toHaveProperty("architecture");
  });

  test("lists only project directories under the memory root", async () => {
    const memoryRoot = await createTempDir("runner-memory-");

    await mkdir(join(memoryRoot, "alpha"), { recursive: true });
    await mkdir(join(memoryRoot, "beta"), { recursive: true });
    await mkdir(join(memoryRoot, "prd"), { recursive: true });
    await mkdir(join(memoryRoot, "skills"), { recursive: true });
    await writeFile(join(memoryRoot, "README.md"), "memory root", "utf8");

    const result = await handleListProjects(memoryRoot);

    expect(result).toEqual({
      projects: ["alpha", "beta"],
    });
  });
});
