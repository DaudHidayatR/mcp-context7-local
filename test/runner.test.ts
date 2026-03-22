import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRunnerApp, type RunnerDependencies } from "../apps/runner/src/index";
import { ChromaRagService } from "../packages/rag/src/index";

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
      query: async (_query, _topK, _namespace) => ([
        {
          content: "Context chunk from docs",
          distance: 0.1,
          id: "doc-1",
          metadata: { path: "README.md" },
        },
      ]),
      syncDirectories: async (_directories, _namespace) => ({
        collection: "test",
        documents: 1,
        indexedAt: "2026-03-20T00:00:00.000Z",
      }),
    },
  };
}

function createNamespaceRefreshApp(deps: RunnerDependencies) {
  return createRunnerApp(
    {
      codexCommand: [bunPath, fixturePath],
      corpusDirs: ["/tmp/docs", "/tmp/memory"],
      geminiCommand: [bunPath, fixturePath],
      port: 3200,
      topK: 5,
    },
    deps,
    {
      CHROMA_URL: "http://127.0.0.1:8000",
      VPS_MEMORY_URL: undefined,
      PRD_DIR: "/tmp/prd",
    },
  );
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
  test("POST /refresh-namespace indexes only the namespace memory directory", async () => {
    const syncCalls: string[][] = [];
    const namespaceCalls: string[] = [];
    const app = createNamespaceRefreshApp({
      ...createDeps(),
      createNamespaceRag: (namespace) => {
        namespaceCalls.push(namespace);
        return {
          syncDirectories: async (directories) => {
            syncCalls.push(directories);
            return {
              collection: namespace,
              documents: 3,
              indexedAt: "2026-03-22T00:00:00.000Z",
            };
          },
        };
      },
    });

    try {
      const response = await app.fetch(
        new Request(new URL("/refresh-namespace", baseUrl), {
          body: JSON.stringify({ namespace: "proj-alpha" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(namespaceCalls).toEqual(["proj-alpha"]);
      expect(syncCalls).toEqual([["/tmp/memory/proj-alpha"]]);
      expect(payload).toEqual({
        collection: "proj-alpha",
        indexedAt: "2026-03-22T00:00:00.000Z",
        indexedDocuments: 3,
        namespace: "proj-alpha",
        status: "refreshed",
      });
    } finally {
      app.dispose();
    }
  });

  test("POST /refresh-namespace rejects an invalid namespace", async () => {
    const app = createNamespaceRefreshApp(createDeps());

    try {
      const response = await app.fetch(
        new Request(new URL("/refresh-namespace", baseUrl), {
          body: JSON.stringify({ namespace: "Bad Namespace" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error).toContain("namespace must match");
    } finally {
      app.dispose();
    }
  });

  test("POST /refresh-namespace returns 500 when namespace sync fails", async () => {
    const app = createNamespaceRefreshApp({
      ...createDeps(),
      createNamespaceRag: () => ({
        syncDirectories: async () => {
          throw new Error("sync failed");
        },
      }),
    });

    try {
      const response = await app.fetch(
        new Request(new URL("/refresh-namespace", baseUrl), {
          body: JSON.stringify({ namespace: "proj-alpha" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload.error).toBe("sync failed");
    } finally {
      app.dispose();
    }
  });

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

describe("runner mcp", () => {
  async function initializeMcpSession(app: ReturnType<typeof createRunnerApp>): Promise<string> {
    const initResponse = await app.fetch(
      new Request(new URL("/mcp", baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initializedResponse = await app.fetch(
      new Request(new URL("/mcp", baseUrl), {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
    );

    expect(initializedResponse.status).toBe(202);
    return sessionId!;
  }

  function createMcpApp() {
    return createRunnerApp(
      {
        codexCommand: [bunPath, fixturePath],
        corpusDirs: ["/tmp/context"],
        geminiCommand: [bunPath, fixturePath],
        port: 3200,
        topK: 5,
      },
      createDeps(),
      {
        CHROMA_URL: "http://127.0.0.1:8000",
        VPS_MEMORY_URL: undefined,
        PRD_DIR: "/tmp/prd",
      },
    );
  }

  test("POST /mcp tools/list returns rag_search and memory_write", async () => {
    const app = createMcpApp();

    try {
      const sessionId = await initializeMcpSession(app);

      // Step 3: List tools
      const listResponse = await app.fetch(
        new Request(new URL("/mcp", baseUrl), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Mcp-Session-Id": sessionId!,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
          }),
        }),
      );

      expect(listResponse.status).toBe(200);

      const listBody = await listResponse.json();
      const toolNames: string[] = listBody.result.tools.map(
        (t: { name: string }) => t.name,
      );

      expect(toolNames).toContain("rag_search");
      expect(toolNames).toContain("memory_write");
      expect(toolNames).toContain("memory_read");
      expect(toolNames).toContain("memory_read_all");
      expect(toolNames).toContain("get_project_context");
      expect(toolNames).toContain("load_skill");
      expect(toolNames).toContain("list_skills");
      expect(toolNames).toContain("list_projects");
      expect(toolNames).toHaveLength(8);
    } finally {
      app.dispose();
    }
  });

  test("POST /mcp tools/call forwards namespace to rag query", async () => {
    const app = createMcpApp();
    const queryCalls: Array<{ namespace?: string; query: string; topK: number }> = [];
    const originalQuery = ChromaRagService.prototype.query;

    ChromaRagService.prototype.query = async function (query, topK, namespace) {
      queryCalls.push({ namespace, query, topK });
      return [{
        content: "Context chunk from docs",
        distance: 0.1,
        id: "doc-1",
        metadata: { namespace, path: "README.md" },
      }];
    };

    try {
      const sessionId = await initializeMcpSession(app);
      const response = await app.fetch(
        new Request(new URL("/mcp", baseUrl), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Mcp-Session-Id": sessionId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "rag_search",
              arguments: {
                namespace: "Project Alpha",
                query: "search term",
                top_k: 3,
              },
            },
          }),
        }),
      );

      expect(response.status).toBe(200);
      const payload = await response.json();

      expect(queryCalls).toEqual([
        { namespace: "Project Alpha", query: "search term", topK: 3 },
      ]);
      expect(payload.result.content[0].text).toContain("\"results\"");
    } finally {
      ChromaRagService.prototype.query = originalQuery;
      app.dispose();
    }
  });
});
