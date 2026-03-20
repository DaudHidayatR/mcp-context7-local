import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRunnerApp, type RunnerDependencies } from "../apps/runner/src/index";

const fixturePath = join(import.meta.dir, "fixtures", "fake-llm-cli.ts");
const bunPath = Bun.which("bun") ?? "bun";
const baseUrl = "http://runner.test";
const originalEnv = {
  CODEX_CMD_JSON: Bun.env.CODEX_CMD_JSON,
  GEMINI_CMD_JSON: Bun.env.GEMINI_CMD_JSON,
};

function createDeps(): RunnerDependencies {
  return {
    mcpClient: {
      call: async () => ({
        content: [{ text: "{\"libraryName\":\"project\"}", type: "text" }],
      }),
      dispose: () => {},
      listTools: async () => ([
        {
          description: "Resolve library IDs",
          inputSchema: { type: "object" },
          name: "ctx7_resolve-library-id",
          originalName: "resolve-library-id",
          server: "context7",
        },
      ]),
    },
    rag: {
      query: async () => ([
        {
          content: "Context chunk from docs",
          distance: 0.1,
          id: "doc-1",
          metadata: { path: "README.md" },
        },
      ]),
      syncDirectories: async () => ({
        collection: "test",
        documents: 1,
        indexedAt: "2026-03-20T00:00:00.000Z",
      }),
    },
  };
}

async function runnerFetch(body: Record<string, unknown>, deps = createDeps()): Promise<Response> {
  const app = createRunnerApp({
    codexCommand: [bunPath, fixturePath],
    corpusDirs: ["/tmp/context"],
    geminiCommand: [bunPath, fixturePath],
    port: 3200,
    topK: 5,
  }, deps);

  await app.refresh();

  try {
    return await app.fetch(new Request(new URL("/query", baseUrl), {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }));
  } finally {
    app.dispose();
  }
}

beforeEach(() => {
  delete Bun.env.FAKE_LLM_FAIL;
});

afterEach(() => {
  Bun.env.CODEX_CMD_JSON = originalEnv.CODEX_CMD_JSON;
  Bun.env.GEMINI_CMD_JSON = originalEnv.GEMINI_CMD_JSON;
  delete Bun.env.FAKE_LLM_FAIL;
});

describe("runner", () => {
  test("defaults to codex when provider is omitted", async () => {
    const response = await runnerFetch({ query: "what is this project" });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.provider).toBe("codex");
    expect(payload.llmResponse).toContain("provider=codex");
    expect(payload.llmResponse).toContain("User Query: what is this project");
  });

  test("supports explicit gemini provider", async () => {
    const response = await runnerFetch({
      provider: "gemini",
      query: "what is this project",
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.provider).toBe("gemini");
    expect(payload.llmResponse).toContain("provider=gemini");
    expect(payload.llmResponse).toContain("User Query: what is this project");
  });

  test("returns 400 for an invalid provider", async () => {
    const response = await runnerFetch({
      provider: "claude",
      query: "what is this project",
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toContain("provider must be one of: codex, gemini");
  });

  test("returns 502 when gemini fails without falling back", async () => {
    Bun.env.FAKE_LLM_FAIL = "1";

    const response = await runnerFetch({
      provider: "gemini",
      query: "what is this project",
    });

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.provider).toBe("gemini");
    expect(payload.error).toContain("fake llm failed");
  });

  test("uses the same prompt body for codex and gemini", async () => {
    const codexResponse = await runnerFetch({ query: "what is this project" });
    const geminiResponse = await runnerFetch({
      provider: "gemini",
      query: "what is this project",
    });

    const codexPayload = await codexResponse.json();
    const geminiPayload = await geminiResponse.json();
    const codexPrompt = codexPayload.llmResponse.replace(/^provider=codex\n/, "");
    const geminiPrompt = geminiPayload.llmResponse.replace(/^provider=gemini\n/, "");

    expect(codexPrompt).toBe(geminiPrompt);
  });
});
