import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatManualChecklist,
  parseCreateProjectArgs,
  runCreateProject,
} from "../scripts/create-project";
import { runSetupProject } from "../scripts/setup-project";

async function createTempProjectEnv(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "create-project-"));
  await writeFile(join(dir, ".env"), contents, "utf8");
  return dir;
}

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
      tempDirs.delete(dir);
    }),
  );
});

describe("create-project args", () => {
  test("parses namespace, name, and local mode", () => {
    expect(parseCreateProjectArgs(["proj-alpha", "--name", "Project Alpha", "--local"])).toEqual({
      displayName: "Project Alpha",
      local: true,
      namespace: "proj-alpha",
    });
  });

  test("rejects invalid namespaces", () => {
    expect(() => parseCreateProjectArgs(["Bad Namespace"])).toThrow("namespace must match");
  });
});

describe("create-project execution", () => {
  test("setup-project creates the filesystem bootstrap", async () => {
    const cwd = await createTempProjectEnv("");
    tempDirs.add(cwd);
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runSetupProject(["proj-alpha", "--name", "Project Alpha"], {
      cwd,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      stderr: (message) => errors.push(message),
      stdout: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toHaveLength(0);
    expect(output).toEqual(formatManualChecklist("proj-alpha", "Project Alpha"));
    expect((await stat(join(cwd, "memory", "proj-alpha"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:meta.json"), "utf8"))).toEqual({
      description: "TODO",
      name: "Project Alpha",
      version: "0.1.0",
    });
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:goals.json"), "utf8"))).toEqual({
      milestones: [],
      primary: "TODO",
    });
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:architecture.json"), "utf8"))).toEqual({
      adrs: [],
      components: [],
    });
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:constraints.json"), "utf8"))).toEqual({
      requirements: [],
    });
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:sops.json"), "utf8"))).toEqual({
      contacts: {},
      incident_response: "TODO",
    });
  });

  test("re-running setup skips existing files", async () => {
    const cwd = await createTempProjectEnv("");
    tempDirs.add(cwd);
    await mkdir(join(cwd, "memory", "prd"), { recursive: true });
    await writeFile(
      join(cwd, "memory", "prd", "proj-alpha:prd:meta.json"),
      JSON.stringify({
        description: "kept",
        name: "Already There",
        version: "9.9.9",
      }, null, 2),
      "utf8",
    );

    const exitCode = await runSetupProject(["proj-alpha"], {
      cwd,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:meta.json"), "utf8"))).toEqual({
      description: "kept",
      name: "Already There",
      version: "9.9.9",
    });
    expect((await stat(join(cwd, "memory", "proj-alpha"))).isDirectory()).toBe(true);
  });

  test("create-project wrapper preserves local mode and avoids network calls", async () => {
    const cwd = await createTempProjectEnv("");
    tempDirs.add(cwd);
    const output: string[] = [];
    const calls: string[] = [];

    const exitCode = await runCreateProject(["proj-alpha", "--local"], {
      cwd,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      },
      stdout: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(output).toEqual(formatManualChecklist("proj-alpha", "proj-alpha"));
    expect((await stat(join(cwd, "memory", "proj-alpha"))).isDirectory()).toBe(true);
    expect(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:meta.json"), "utf8")).toContain("\"name\": \"proj-alpha\"");
  });

  test("best-effort network failures only warn and still bootstrap files", async () => {
    const cwd = await createTempProjectEnv([
      "GATEWAY_AUTH_TOKEN=secret-token",
      "VPS_MEMORY_URL=http://memory.example:8082/",
    ].join("\n"));
    tempDirs.add(cwd);

    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const output: string[] = [];
    const warnings: string[] = [];

    const exitCode = await runSetupProject(["proj-alpha", "--name", "Project Alpha"], {
      cwd,
      fetchImpl: async (url, init) => {
        requests.push({
          body: String(init?.body ?? ""),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        if (String(url).includes("refresh-namespace")) {
          throw new TypeError("network down");
        }
        return new Response("memory unavailable", { status: 503, statusText: "Service Unavailable" });
      },
      now: () => new Date("2026-03-22T01:02:03.000Z"),
      stderr: (message) => warnings.push(message),
      stdout: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("http://127.0.0.1:3200/refresh-namespace");
    expect(requests[0].headers.get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(requests[0].body)).toEqual({ namespace: "proj-alpha" });
    expect(requests[1].url).toBe("http://memory.example:8082/write");
    expect(JSON.parse(requests[1].body)).toEqual({
      key: "init",
      namespace: "proj-alpha",
      scope: "project",
      tags: ["init"],
      value: {
        created: "2026-03-22T01:02:03.000Z",
        name: "Project Alpha",
      },
    });
    expect(warnings[0]).toContain("refresh-namespace failed");
    expect(warnings[1]).toContain("memory_write(init) failed");
    expect(output).toEqual(formatManualChecklist("proj-alpha", "Project Alpha"));
    expect((await stat(join(cwd, "memory", "proj-alpha"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "memory", "prd", "proj-alpha:prd:meta.json"), "utf8"))).toEqual({
      description: "TODO",
      name: "Project Alpha",
      version: "0.1.0",
    });
  });
});
