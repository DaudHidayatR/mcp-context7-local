/**
 * MCP Server for the Runner — exposes namespace-aware tools via streamable-http transport.
 *
 * Tools:
 *   - rag_search(query, namespace, top_k)
 *   - memory_read(scope, namespace, key)
 *   - memory_read_all(scope, namespace)
 *   - memory_write(scope, namespace, key, value, tags, ttl_seconds)
 *   - get_project_context(task_type, namespace)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ChromaRagService } from "@platform/rag";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  chromaUrl: string;
  memoryUrl: string | undefined;
  prdDir: string;
}

// ---------------------------------------------------------------------------
// In-memory fallback store (used when VPS_MEMORY_URL is not set)
// ---------------------------------------------------------------------------

interface MemEntry {
  value: unknown;
  version: number;
  expiresAt: number | null;
  tags: string[];
  writtenAt: number;
}

export class InMemoryStore {
  private data = new Map<string, MemEntry>();

  private key(scope: string, namespace: string, key: string): string {
    return `${scope}::${namespace}::${key}`;
  }

  read(scope: string, namespace: string, key: string): {
    value: unknown;
    found: boolean;
    age_seconds: number;
    version: number;
  } {
    const k = this.key(scope, namespace, key);
    const entry = this.data.get(k);
    if (!entry) return { value: null, found: false, age_seconds: 0, version: 0 };

    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.data.delete(k);
      return { value: null, found: false, age_seconds: 0, version: 0 };
    }

    return {
      value: entry.value,
      found: true,
      age_seconds: Math.floor((Date.now() - entry.writtenAt) / 1000),
      version: entry.version,
    };
  }

  readAll(scope: string, namespace: string): {
    entries: Array<{ key: string; value: unknown; age_seconds: number; version: number }>;
  } {
    const prefix = `${scope}::${namespace}::`;
    const entries: Array<{ key: string; value: unknown; age_seconds: number; version: number }> = [];

    for (const [k, entry] of this.data) {
      if (!k.startsWith(prefix)) continue;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        this.data.delete(k);
        continue;
      }
      entries.push({
        key: k.slice(prefix.length),
        value: entry.value,
        age_seconds: Math.floor((Date.now() - entry.writtenAt) / 1000),
        version: entry.version,
      });
    }

    return { entries };
  }

  write(
    scope: string,
    namespace: string,
    key: string,
    value: unknown,
    tags: string[],
    ttlSeconds: number | null,
  ): { ok: boolean; version_id: number } {
    const k = this.key(scope, namespace, key);
    const existing = this.data.get(k);
    const version = existing ? existing.version + 1 : 1;

    this.data.set(k, {
      value,
      version,
      expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
      tags,
      writtenAt: existing?.writtenAt ?? Date.now(),
    });

    return { ok: true, version_id: version };
  }
}

// ---------------------------------------------------------------------------
// RAG service
// ---------------------------------------------------------------------------

function createRagService(chromaUrl: string): ChromaRagService {
  return new ChromaRagService({
    collectionName: "context7-local",
    url: chromaUrl,
  });
}

// ---------------------------------------------------------------------------
// VPS memory proxy
// ---------------------------------------------------------------------------

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
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Memory service request timed out after 5s");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PRD / get_project_context (local filesystem fallback)
// ---------------------------------------------------------------------------

type TaskType = "feature_dev" | "security_review" | "incident" | "general";

const TASK_TYPE_SECTIONS: Record<TaskType, string[]> = {
  feature_dev: ["meta", "goals", "architecture"],
  security_review: ["meta", "constraints", "sops"],
  incident: ["meta", "sops", "constraints"],
  general: ["meta", "goals"],
};

async function loadProjectContext(
  prdDir: string,
  taskType: TaskType,
  namespace: string,
): Promise<Record<string, unknown>> {
  const sections = TASK_TYPE_SECTIONS[taskType];
  const context: Record<string, unknown> = {};

  for (const section of sections) {
    const filePath = join(prdDir, `${namespace}:prd:${section}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      context[section] = JSON.parse(raw);
    } catch {
      // silently omit missing sections
    }
  }

  return context;
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

export function createMcpServerInstance(config: McpServerConfig) {
  const rag = createRagService(config.chromaUrl);
  const localMemory = new InMemoryStore();
  const useLocalMemory = !config.memoryUrl;

  const server = new McpServer({
    name: "context7-runner",
    version: "1.0.0",
  });

  // NOTE: inputSchema casts are needed because Zod v4 types don't satisfy the
  // SDK's Zod v3-based AnySchema constraint. This is a type-only issue — works fine at runtime.

  // -- rag_search --
  server.registerTool(
    "rag_search",
    {
      description: "Search the RAG index for relevant documents. The namespace maps to the ChromaDB collection name.",
      inputSchema: {
        query: z.string().describe("The search query"),
        namespace: z.string().describe("ChromaDB collection / namespace to search"),
        top_k: z.number().int().positive().default(5).describe("Number of results to return"),
      } as any,
    },
    async ({ query, namespace, top_k }: { query: string; namespace: string; top_k: number }) => {
      const hits = await rag.query(query, top_k, namespace);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results: hits }) }],
      };
    },
  );

  // -- memory_read --
  server.registerTool(
    "memory_read",
    {
      description: "Read a single memory entry by scope, namespace, and key.",
      inputSchema: {
        scope: z.string().describe("Memory scope (e.g. 'agent', 'global')"),
        namespace: z.string().describe("Namespace for grouping entries"),
        key: z.string().describe("Entry key"),
      } as any,
    },
    async ({ scope, namespace, key }: { scope: string; namespace: string; key: string }) => {
      let result: unknown;
      if (useLocalMemory) {
        result = localMemory.read(scope, namespace, key);
      } else {
        result = await proxyToMemory(`${config.memoryUrl}/read`, { scope, namespace, key });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -- memory_read_all --
  server.registerTool(
    "memory_read_all",
    {
      description: "Read all memory entries for a given scope and namespace.",
      inputSchema: {
        scope: z.string().describe("Memory scope (e.g. 'agent', 'global')"),
        namespace: z.string().describe("Namespace for grouping entries"),
      } as any,
    },
    async ({ scope, namespace }: { scope: string; namespace: string }) => {
      let result: unknown;
      if (useLocalMemory) {
        result = localMemory.readAll(scope, namespace);
      } else {
        result = await proxyToMemory(`${config.memoryUrl}/read-all`, { scope, namespace });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -- memory_write --
  server.registerTool(
    "memory_write",
    {
      description: "Write a memory entry with optional tags and TTL.",
      inputSchema: {
        scope: z.string().describe("Memory scope (e.g. 'agent', 'global')"),
        namespace: z.string().describe("Namespace for grouping entries"),
        key: z.string().describe("Entry key"),
        value: z.any().describe("Value to store (any JSON-serializable value)"),
        tags: z.array(z.string()).default([]).describe("Optional tags for filtering"),
        ttl_seconds: z.number().int().positive().nullable().default(null).describe("Optional TTL in seconds"),
      } as any,
    },
    async ({ scope, namespace, key, value, tags, ttl_seconds }: {
      scope: string; namespace: string; key: string; value: unknown; tags: string[]; ttl_seconds: number | null;
    }) => {
      let result: unknown;
      if (useLocalMemory) {
        result = localMemory.write(scope, namespace, key, value, tags, ttl_seconds);
      } else {
        result = await proxyToMemory(`${config.memoryUrl}/write`, {
          scope,
          namespace,
          key,
          value: typeof value === "string" ? value : JSON.stringify(value),
          tags,
          ttl_seconds,
        });
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // -- get_project_context --
  server.registerTool(
    "get_project_context",
    {
      description: "Get project context (PRD sections) for a given task type and namespace.",
      inputSchema: {
        task_type: z
          .enum(["feature_dev", "security_review", "incident", "general"])
          .describe("Type of task that determines which PRD sections are returned"),
        namespace: z.string().describe("Project namespace"),
      } as any,
    },
    async ({ task_type, namespace }: { task_type: string; namespace: string }) => {
      const context = await loadProjectContext(config.prdDir, task_type as TaskType, namespace);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ project_context: context }),
          },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP handler — wires POST /mcp to WebStandardStreamableHTTPServerTransport
// ---------------------------------------------------------------------------

export function createMcpHandler(config: McpServerConfig): (req: Request) => Promise<Response> {
  const server = createMcpServerInstance(config);
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (req: Request): Promise<Response> => {
    const sessionId = req.headers.get("mcp-session-id");

    // DELETE /mcp — destroy session
    if (req.method === "DELETE") {
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.close();
        sessions.delete(sessionId);
      }
      return new Response(null, { status: 204 });
    }

    // GET /mcp — standalone SSE stream (optional)
    if (req.method === "GET") {
      const existingTransport = sessionId ? sessions.get(sessionId) : undefined;
      if (existingTransport) {
        return existingTransport.handleRequest(req);
      }
      return new Response(JSON.stringify({ error: "No session" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // POST /mcp — handle MCP JSON-RPC
    if (req.method === "POST") {
      const existingTransport = sessionId ? sessions.get(sessionId) : undefined;

      if (existingTransport) {
        return existingTransport.handleRequest(req);
      }

      // New session — create transport and connect
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      await server.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  };
}
