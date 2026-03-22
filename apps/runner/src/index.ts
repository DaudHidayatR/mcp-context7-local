import { defaultServersFromEnv, MCPClient, type MCPCallResult, type MCPTool } from "@platform/mcp-client";
import {
  ChromaRagService,
  defaultCorpusDirectories,
  defaultRagConfig,
  type RagHit,
  type RagSyncResult,
} from "@platform/rag";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { basename, join } from "node:path";
import { InMemoryStore, handleMemoryRead, handleMemoryReadAll, handleMemoryWrite } from "./tools/memory";
import { handleGetProjectContext, handleListProjects } from "./tools/project";
import { handleRagSearch } from "./tools/rag";
import { handleListSkills, handleLoadSkill } from "./tools/skills";

export type QueryProvider = "codex" | "gemini";

export interface RunnerState {
  enabledServers: string[];
  indexedAt: string | null;
  indexedDocuments: number;
  lastError: string | null;
  ready: boolean;
  toolCount: number;
}

export interface QueryRequest {
  libraryName?: string;
  provider?: QueryProvider;
  query: string;
}

export interface RunnerConfig {
  codexCommand: string[];
  corpusDirs: string[];
  geminiCommand: string[];
  port: number;
  topK: number;
}

export interface RunnerDependencies {
  mcpClient: {
    dispose(): void;
    listTools(): Promise<MCPTool[]>;
    call(name: string, input: unknown): Promise<MCPCallResult>;
  };
  rag: {
    query(query: string, topK: number, namespace?: string): Promise<RagHit[]>;
    syncDirectories(directories: string[], namespace?: string): Promise<RagSyncResult>;
  };
  createNamespaceRag?: (namespace: string) => {
    syncDirectories(directories: string[]): Promise<RagSyncResult>;
  };
}

export interface RunnerApp {
  config: RunnerConfig;
  dispose: () => void;
  fetch: (req: Request) => Promise<Response>;
  refresh: () => Promise<void>;
  state: RunnerState;
}

export interface RunnerHandle {
  app: RunnerApp;
  server: Bun.Server<undefined>;
  stop: () => void;
}

class ProviderExecutionError extends Error {
  constructor(public readonly provider: QueryProvider, message: string) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommand(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("command override must be valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || !part)) {
    throw new Error("command override must be a non-empty JSON string array");
  }

  return [...parsed];
}

export function loadRunnerConfig(env: Record<string, string | undefined> = Bun.env): RunnerConfig {
  return {
    codexCommand: parseCommand(env.CODEX_CMD_JSON, ["codex"]),
    corpusDirs: defaultCorpusDirectories("/app"),
    geminiCommand: parseCommand(env.GEMINI_CMD_JSON, ["gemini"]),
    port: parsePort(env.RUNNER_PORT, 3200),
    topK: parsePort(env.RAG_TOP_K, 5),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function findResolveTool(tools: MCPTool[]): MCPTool | undefined {
  return tools.find((tool) => tool.name.endsWith("resolve-library-id"));
}

function isQueryProvider(value: unknown): value is QueryProvider {
  return value === "codex" || value === "gemini";
}

function isValidNamespace(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value) && value.length >= 3 && value.length <= 40;
}

function resolveMemoryRoot(corpusDirs: string[]): string {
  const memoryDir = corpusDirs.find((directory) => basename(directory) === "memory");
  if (!memoryDir) {
    throw new Error("runner memory corpus directory is not configured");
  }

  return memoryDir;
}

function resolveRunnerMemoryRoot(corpusDirs: string[]): string {
  try {
    return resolveMemoryRoot(corpusDirs);
  } catch {
    return join(import.meta.dir, "../../..", "memory");
  }
}

interface RunnerMcpConfig {
  chromaUrl: string;
  memoryRoot: string;
  memoryUrl: string | undefined;
  prdDir: string;
}

interface RunnerMcpSession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
}

interface RunnerMcpRuntime {
  dispose: () => void;
  fetch: (req: Request) => Promise<Response>;
}

const RUNNER_MCP_TOOLS = [
  {
    description: "Search the RAG index for relevant documents. The namespace maps to the ChromaDB collection name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        namespace: { type: "string", description: "ChromaDB collection / namespace to search" },
        top_k: { type: "integer", minimum: 1, default: 5, description: "Number of results to return" },
      },
      required: ["query", "namespace"],
      additionalProperties: false,
    },
    name: "rag_search",
  },
  {
    description: "Read a single memory entry by scope, namespace, and key.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope (e.g. 'agent', 'global')" },
        namespace: { type: "string", description: "Namespace for grouping entries" },
        key: { type: "string", description: "Entry key" },
      },
      required: ["scope", "namespace", "key"],
      additionalProperties: false,
    },
    name: "memory_read",
  },
  {
    description: "Read all memory entries for a given scope and namespace.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope (e.g. 'agent', 'global')" },
        namespace: { type: "string", description: "Namespace for grouping entries" },
      },
      required: ["scope", "namespace"],
      additionalProperties: false,
    },
    name: "memory_read_all",
  },
  {
    description: "Write a memory entry with optional tags and TTL.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Memory scope (e.g. 'agent', 'global')" },
        namespace: { type: "string", description: "Namespace for grouping entries" },
        key: { type: "string", description: "Entry key" },
        value: { description: "Value to store (any JSON-serializable value)" },
        tags: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Optional tags for filtering",
        },
        ttl_seconds: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          default: null,
          description: "Optional TTL in seconds",
        },
      },
      required: ["scope", "namespace", "key", "value"],
      additionalProperties: false,
    },
    name: "memory_write",
  },
  {
    description: "Get project context (PRD sections) for a given task type and namespace.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          enum: ["feature_dev", "security_review", "incident", "general"],
          description: "Type of task that determines which PRD sections are returned",
        },
        namespace: { type: "string", description: "Project namespace" },
      },
      required: ["task_type", "namespace"],
      additionalProperties: false,
    },
    name: "get_project_context",
  },
  {
    description: "Load a complete procedural skill document by skill slug.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill slug to load" },
      },
      required: ["skill_name"],
      additionalProperties: false,
    },
    name: "load_skill",
  },
  {
    description: "List available procedural skills exposed to the runner.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    name: "list_skills",
  },
  {
    description: "List project namespaces discovered under the memory root.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    name: "list_projects",
  },
] as const;

async function proxyToMemory(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Memory service returned ${response.status}: ${text}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Memory service request timed out after 5s");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createToolResult(value: unknown, isError = false) {
  return isError
    ? {
      content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
      isError: true,
    }
    : {
      content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
    };
}

function createRunnerMcpRuntime(config: RunnerMcpConfig): RunnerMcpRuntime {
  const sessions = new Map<string, RunnerMcpSession>();
  const rag = new ChromaRagService({
    collectionName: "context7-local",
    url: config.chromaUrl,
  });
  const localMemory = new InMemoryStore();
  const repoRoot = join(import.meta.dir, "../../..");

  const callTool = async (name: string, args: unknown) => {
    try {
      switch (name) {
        case "rag_search": {
          return createToolResult(await handleRagSearch(args, rag));
        }
        case "memory_read": {
          return createToolResult(await handleMemoryRead(args, {
            memoryUrl: config.memoryUrl,
            proxyToMemory,
            store: localMemory,
          }));
        }
        case "memory_read_all": {
          return createToolResult(await handleMemoryReadAll(args, {
            memoryUrl: config.memoryUrl,
            proxyToMemory,
            store: localMemory,
          }));
        }
        case "memory_write": {
          return createToolResult(await handleMemoryWrite(args, {
            memoryUrl: config.memoryUrl,
            proxyToMemory,
            store: localMemory,
          }));
        }
        case "get_project_context": {
          return createToolResult(await handleGetProjectContext(args, config.prdDir));
        }
        case "load_skill": {
          return createToolResult(await handleLoadSkill(args, repoRoot));
        }
        case "list_skills": {
          return createToolResult(await handleListSkills(repoRoot));
        }
        case "list_projects": {
          return createToolResult(await handleListProjects(config.memoryRoot));
        }
        default:
          return createToolResult(`Tool ${name} not found`, true);
      }
    } catch (error) {
      return createToolResult(error instanceof Error ? error.message : String(error), true);
    }
  };

  const createServer = (): Server => {
    const server = new Server(
      { name: "context7-runner", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    // handles tools/list
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...RUNNER_MCP_TOOLS],
    }));

    // handles tools/call
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return callTool(request.params.name, request.params.arguments);
    });

    return server;
  };

  const createSession = async (): Promise<RunnerMcpSession> => {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, entry);
      },
    });
    const entry: RunnerMcpSession = { server, transport };

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    return entry;
  };

  return {
    dispose: () => {
      for (const { transport } of sessions.values()) {
        void transport.close();
      }
      sessions.clear();
    },
    fetch: async (req: Request): Promise<Response> => {
      const sessionId = req.headers.get("mcp-session-id");

      if (req.method === "DELETE") {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.transport.close();
          sessions.delete(sessionId!);
        }
        return new Response(null, { status: 204 });
      }

      if (req.method === "GET") {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (!existing) {
          return jsonResponse({ error: "No session" }, 400);
        }
        return existing.transport.handleRequest(req);
      }

      if (req.method === "POST") {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          return existing.transport.handleRequest(req);
        }

        const created = await createSession();
        return created.transport.handleRequest(req);
      }

      return jsonResponse({ error: "Method not allowed" }, 405);
    },
  };
}

async function readQueryRequest(req: Request): Promise<QueryRequest> {
  const body = await req.json() as Partial<QueryRequest>;
  if (!body.query || typeof body.query !== "string") {
    throw new Error("query is required");
  }
  if (body.libraryName !== undefined && typeof body.libraryName !== "string") {
    throw new Error("libraryName must be a string");
  }
  if (body.provider !== undefined && !isQueryProvider(body.provider)) {
    throw new Error("provider must be one of: codex, gemini");
  }

  return {
    libraryName: body.libraryName,
    provider: body.provider ?? "codex",
    query: body.query,
  };
}

async function readNamespaceRequest(req: Request): Promise<{ namespace: string }> {
  const body = await req.json() as { namespace?: unknown };
  if (typeof body.namespace !== "string" || !isValidNamespace(body.namespace)) {
    throw new Error("namespace must match /^[a-z0-9-]+$/ and be 3-40 chars");
  }

  return { namespace: body.namespace };
}

function buildPrompt(query: string, ragContext: string): string {
  return `You are a helpful AI assistant. Use the following context to answer the user's query.\n\n<context>\n${ragContext}\n</context>\n\nUser Query: ${query}`;
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function runProvider(provider: QueryProvider, prompt: string, config: RunnerConfig): Promise<string> {
  const command = provider === "gemini"
    ? [...config.geminiCommand, "-p", prompt, "-o", "text"]
    : config.codexCommand;

  try {
    const proc = Bun.spawn(command, {
      env: process.env,
      stderr: "pipe",
      stdin: provider === "codex" ? new Blob([prompt]) : "ignore",
      stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamText(proc.stdout),
      readStreamText(proc.stderr),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `${provider} exited with code ${exitCode}`;
      throw new ProviderExecutionError(provider, detail);
    }

    return stdout.trim();
  } catch (error) {
    if (error instanceof ProviderExecutionError) throw error;
    throw new ProviderExecutionError(provider, error instanceof Error ? error.message : String(error));
  }
}

async function runQuery(request: QueryRequest, config: RunnerConfig, deps: RunnerDependencies) {
  const tools = await deps.mcpClient.listTools();
  const hits = await deps.rag.query(request.query, config.topK);
  const resolveTool = findResolveTool(tools);

  let toolResult: MCPCallResult | null = null;
  if (resolveTool) {
    toolResult = await deps.mcpClient.call(resolveTool.name, {
      libraryName: request.libraryName ?? request.query,
    });
  }

  const ragContext = hits.map((hit) => hit.content).join("\n\n");
  const provider = request.provider ?? "codex";

  return {
    hits,
    llmResponse: await runProvider(provider, buildPrompt(request.query, ragContext), config),
    provider,
    toolResult,
    tools: tools.map((tool) => tool.name),
  };
}

export function createRunnerApp(
  config = loadRunnerConfig(Bun.env),
  deps: RunnerDependencies = {
    mcpClient: new MCPClient(defaultServersFromEnv(Bun.env)),
    rag: new ChromaRagService(defaultRagConfig(Bun.env)),
    createNamespaceRag: (namespace: string) => new ChromaRagService({
      collectionName: namespace,
      url: Bun.env.CHROMA_URL ?? "http://127.0.0.1:8000",
    }),
  },
  env: Record<string, string | undefined> = Bun.env,
): RunnerApp {
  const mcpConfig: RunnerMcpConfig = {
    chromaUrl: env.CHROMA_URL ?? "http://127.0.0.1:8000",
    memoryRoot: resolveRunnerMemoryRoot(config.corpusDirs),
    memoryUrl: env.VPS_MEMORY_URL || undefined,
    prdDir: env.PRD_DIR ?? join(import.meta.dir, "../../..", "memory", "prd"),
  };
  const mcpRuntime = createRunnerMcpRuntime(mcpConfig);
  const createNamespaceRag = deps.createNamespaceRag ?? ((namespace: string) => new ChromaRagService({
    collectionName: namespace,
    url: env.CHROMA_URL ?? "http://127.0.0.1:8000",
  }));

  const state: RunnerState = {
    enabledServers: defaultServersFromEnv(env).map((server) => server.name),
    indexedAt: null,
    indexedDocuments: 0,
    lastError: null,
    ready: false,
    toolCount: 0,
  };

  async function refresh(): Promise<void> {
    const [syncResult, tools] = await Promise.all([
      deps.rag.syncDirectories(config.corpusDirs),
      deps.mcpClient.listTools(),
    ]);

    state.indexedAt = syncResult.indexedAt;
    state.indexedDocuments = syncResult.documents;
    state.toolCount = tools.length;
    state.lastError = null;
    state.ready = true;
  }

  return {
    config,
    dispose: () => {
      mcpRuntime.dispose();
      deps.mcpClient.dispose();
    },
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return jsonResponse({
          ...state,
          corpusDirs: config.corpusDirs,
          status: "ok",
        });
      }

      if (url.pathname === "/ready" && req.method === "GET") {
        if (state.ready) {
          return jsonResponse({ status: "ready" });
        }
        return jsonResponse({ error: state.lastError ?? "runner is not ready" }, 503);
      }

      if (url.pathname === "/refresh" && req.method === "POST") {
        try {
          state.ready = false;
          await refresh();
          return jsonResponse({
            indexedAt: state.indexedAt,
            indexedDocuments: state.indexedDocuments,
            status: "refreshed",
          });
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          return jsonResponse({ error: state.lastError }, 500);
        }
      }

      if (url.pathname === "/refresh-namespace" && req.method === "POST") {
        try {
          const { namespace } = await readNamespaceRequest(req);
          let memRoot: string;
          try {
            memRoot = resolveMemoryRoot(config.corpusDirs);
          } catch {
            memRoot = join(import.meta.dir, "../../..", "memory");
          }
          const syncResult = await createNamespaceRag(namespace).syncDirectories([
            join(memRoot, namespace),
          ]);
          return jsonResponse({
            collection: syncResult.collection,
            indexedAt: syncResult.indexedAt,
            indexedDocuments: syncResult.documents,
            namespace,
            status: "refreshed",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes("namespace must match") ? 400 : 500;
          return jsonResponse({ error: message }, status);
        }
      }

      if (url.pathname === "/query" && req.method === "POST") {
        try {
          const request = await readQueryRequest(req);
          const result = await runQuery(request, config, deps);
          return jsonResponse({
            indexedAt: state.indexedAt,
            query: request.query,
            ...result,
          });
        } catch (error) {
          if (error instanceof ProviderExecutionError) {
            return jsonResponse({
              error: error.message,
              provider: error.provider,
            }, 502);
          }

          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 400);
        }
      }

      // /mcp delegates MCP tools/list and tools/call requests to the runner MCP runtime.
      if (url.pathname === "/mcp" && (req.method === "POST" || req.method === "DELETE" || req.method === "GET")) {
        return mcpRuntime.fetch(req);
      }

      return jsonResponse({ error: "Not found" }, 404);
    },
    refresh,
    state,
  };
}

export function createRunnerServer(
  config = loadRunnerConfig(Bun.env),
  deps: RunnerDependencies = {
    mcpClient: new MCPClient(defaultServersFromEnv(Bun.env)),
    rag: new ChromaRagService(defaultRagConfig(Bun.env)),
  },
): RunnerHandle {
  const app = createRunnerApp(config, deps);
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    error: (error) => {
      console.error("[runner] unhandled error:", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    },
  });

  return {
    app,
    server,
    stop: () => {
      app.dispose();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const handle = createRunnerServer();

  const bootstrap = async () => {
    try {
      await handle.app.refresh();
      console.log(`[runner] listening on :${handle.server.port}`);
      console.log(`[runner] enabled servers: ${handle.app.state.enabledServers.join(", ") || "none"}`);
      console.log(`[runner] indexed documents: ${handle.app.state.indexedDocuments}`);
    } catch (error) {
      handle.app.state.lastError = error instanceof Error ? error.message : String(error);
      console.error("[runner] bootstrap failed:", handle.app.state.lastError);
    }
  };

  bootstrap();

  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
