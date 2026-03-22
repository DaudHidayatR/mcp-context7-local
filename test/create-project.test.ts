import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatManualChecklist,
  parseCreateProjectArgs,
  runCreateProject,
} from "../scripts/create-project";

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
  test("prints checklist only in local mode", async () => {
    const cwd = await createTempProjectEnv("CHROMA_URL=http://chroma:8000\n");
    tempDirs.add(cwd);
    const calls: string[] = [];
    const output: string[] = [];

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
  });

  test("calls runner then memory service with the expected payloads", async () => {
    const cwd = await createTempProjectEnv([
      "CHROMA_URL=http://chroma:8000",
      "GATEWAY_AUTH_TOKEN=secret-token",
      "VPS_MEMORY_URL=http://memory.example:8082/",
    ].join("\n"));
    tempDirs.add(cwd);

    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const output: string[] = [];

    const exitCode = await runCreateProject(["proj-alpha", "--name", "Project Alpha"], {
      cwd,
      fetchImpl: async (url, init) => {
        requests.push({
          body: String(init?.body ?? ""),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      now: () => new Date("2026-03-22T01:02:03.000Z"),
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
    expect(output).toEqual(formatManualChecklist("proj-alpha", "Project Alpha"));
  });

  test("falls back to localhost memory-service when VPS_MEMORY_URL is missing", async () => {
    const cwd = await createTempProjectEnv("CHROMA_URL=http://chroma:8000\n");
    tempDirs.add(cwd);
    const urls: string[] = [];

    const exitCode = await runCreateProject(["proj-alpha"], {
      cwd,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(urls).toEqual([
      "http://127.0.0.1:3200/refresh-namespace",
      "http://127.0.0.1:8082/write",
    ]);
  });

  test("returns a non-zero exit code when the runner refresh fails", async () => {
    const cwd = await createTempProjectEnv("CHROMA_URL=http://chroma:8000\n");
    tempDirs.add(cwd);
    const errors: string[] = [];

    const exitCode = await runCreateProject(["proj-alpha"], {
      cwd,
      fetchImpl: async (url) => {
        if (String(url).includes("refresh-namespace")) {
          return new Response("runner down", { status: 503, statusText: "Service Unavailable" });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      stderr: (message) => errors.push(message),
      stdout: () => {},
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("http://127.0.0.1:3200/refresh-namespace returned 503");
  });
});
