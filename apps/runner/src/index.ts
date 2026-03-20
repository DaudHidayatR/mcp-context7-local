import { defaultServersFromEnv, MCPClient, type MCPCallResult, type MCPTool } from "@platform/mcp-client";
import {
  ChromaRagService,
  defaultCorpusDirectories,
  defaultRagConfig,
  type RagHit,
  type RagSyncResult,
} from "@platform/rag";

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
    query(query: string, topK: number): Promise<RagHit[]>;
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
  },
): RunnerApp {
  const state: RunnerState = {
    enabledServers: defaultServersFromEnv(Bun.env).map((server) => server.name),
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
    dispose: () => deps.mcpClient.dispose(),
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
