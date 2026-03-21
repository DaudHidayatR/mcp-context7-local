/**
 * Cloudflare Worker — MCP Entrypoint (Split Architecture)
 *
 * Receives MCP tool call requests over HTTP (JSON-RPC 2.0),
 * routes them to VPS Go services or Cloudflare KV,
 * and returns MCP-compliant tool result JSON.
 */

// ---------------------------------------------------------------------------
// Type declarations for Cloudflare Worker environment
// ---------------------------------------------------------------------------

interface Env {
  PRD_KV: KVNamespace;
  VPS_RAG_URL: string;
  VPS_MEMORY_URL: string;
  SECRET: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface ToolResult {
  type: "text";
  text: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: {
    content: ToolResult[];
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// PRD Context — KV schema & task_type mapping
// ---------------------------------------------------------------------------

type TaskType = "feature_dev" | "security_review" | "incident" | "general";

const TASK_TYPE_SECTIONS: Record<TaskType, string[]> = {
  feature_dev: ["prd:meta", "prd:goals", "prd:architecture"],
  security_review: ["prd:meta", "prd:constraints", "prd:sops"],
  incident: ["prd:meta", "prd:sops", "prd:constraints"],
  general: ["prd:meta", "prd:goals"],
};

const KV_KEY_TO_SECTION: Record<string, string> = {
  "prd:meta": "meta",
  "prd:goals": "goals",
  "prd:constraints": "constraints",
  "prd:architecture": "architecture",
  "prd:sops": "sops",
};

function isValidTaskType(value: unknown): value is TaskType {
  return (
    typeof value === "string" &&
    ["feature_dev", "security_review", "incident", "general"].includes(value)
  );
}

/**
 * Truncate architecture.adrs array to 5 items to stay under 2000 token budget.
 */
function truncateContext(context: Record<string, unknown>): Record<string, unknown> {
  if (
    context.architecture &&
    typeof context.architecture === "object" &&
    context.architecture !== null
  ) {
    const arch = context.architecture as Record<string, unknown>;
    if (Array.isArray(arch.adrs) && arch.adrs.length > 5) {
      arch.adrs = arch.adrs.slice(0, 5);
    }
  }
  return context;
}

async function handleGetProjectContext(
  args: Record<string, unknown>,
  kv: KVNamespace
): Promise<Record<string, unknown>> {
  const taskType = args.task_type;
  if (!isValidTaskType(taskType)) {
    throw new Error(
      `Invalid task_type: ${String(taskType)}. Must be one of: feature_dev, security_review, incident, general`
    );
  }

  const kvKeys = TASK_TYPE_SECTIONS[taskType];
  const projectContext: Record<string, unknown> = {};

  // Fetch all KV keys in parallel
  const entries = await Promise.all(
    kvKeys.map(async (key) => {
      const value = await kv.get(key, "text");
      return { key, value };
    })
  );

  for (const { key, value } of entries) {
    if (value === null) continue; // Silently omit missing sections

    const sectionName = KV_KEY_TO_SECTION[key];
    if (!sectionName) continue;

    try {
      projectContext[sectionName] = JSON.parse(value);
    } catch {
      // If value isn't valid JSON, store as-is
      projectContext[sectionName] = value;
    }
  }

  return { project_context: truncateContext(projectContext) };
}

// ---------------------------------------------------------------------------
// VPS proxy with timeout
// ---------------------------------------------------------------------------

async function proxyToVps(
  url: string,
  body: unknown,
  timeoutMs = 5000
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`VPS returned ${response.status}: ${text}`);
    }

    return await response.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("VPS request timed out after 5s");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
  env: Env
) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  rag_search: async (args, env) => {
    return proxyToVps(`${env.VPS_RAG_URL}/search`, args);
  },

  memory_read: async (args, env) => {
    return proxyToVps(`${env.VPS_MEMORY_URL}/read`, args);
  },

  memory_write: async (args, env) => {
    return proxyToVps(`${env.VPS_MEMORY_URL}/write`, args);
  },

  get_project_context: async (args, env) => {
    return handleGetProjectContext(args, env.PRD_KV);
  },
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function validateAuth(request: Request, secret: string): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  const [scheme, token] = authHeader.split(" ");
  return scheme === "Bearer" && token === secret;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function jsonRpcSuccess(id: string | number, data: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    },
  };
}

function jsonRpcToolError(
  id: string | number,
  message: string
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    },
  };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? 0,
    error: { code, message },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health endpoint — unauthenticated
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true });
    }

    // All other endpoints require auth
    if (!validateAuth(request, env.SECRET)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Only accept POST for MCP tool calls
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonResponse(
        jsonRpcError(null, -32700, "Parse error: invalid JSON"),
        400
      );
    }

    // Validate JSON-RPC structure
    if (rpcRequest.jsonrpc !== "2.0" || !rpcRequest.id) {
      return jsonResponse(
        jsonRpcError(rpcRequest?.id ?? null, -32600, "Invalid JSON-RPC request"),
        400
      );
    }

    // Route tools/call method
    if (rpcRequest.method !== "tools/call") {
      return jsonResponse(
        jsonRpcError(rpcRequest.id, -32601, `Method not found: ${rpcRequest.method}`),
        200
      );
    }

    const toolName = rpcRequest.params?.name;
    const toolArgs = (rpcRequest.params?.arguments ?? {}) as Record<
      string,
      unknown
    >;

    if (!toolName || typeof toolName !== "string") {
      return jsonResponse(
        jsonRpcError(rpcRequest.id, -32602, "Missing tool name in params"),
        200
      );
    }

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return jsonResponse(
        jsonRpcToolError(rpcRequest.id, `Unknown tool: ${toolName}`),
        200
      );
    }

    try {
      const result = await handler(toolArgs, env);
      return jsonResponse(jsonRpcSuccess(rpcRequest.id, result));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal tool error";
      // Return MCP-compliant tool error, not a 500
      return jsonResponse(jsonRpcToolError(rpcRequest.id, message));
    }
  },
};

// Export for testing
export {
  handleGetProjectContext,
  TASK_TYPE_SECTIONS,
  KV_KEY_TO_SECTION,
  truncateContext,
  isValidTaskType,
};
export type { TaskType, Env };
