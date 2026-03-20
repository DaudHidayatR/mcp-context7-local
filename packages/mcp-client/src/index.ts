import { sanitizeToolName } from "./sanitize";

export type MCPTransport = "streamable-http" | "sse";
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MCPServerConfig {
  authToken?: string;
  eventSourceFactory?: (url: string) => EventSource;
  fetchImpl?: FetchLike;
  name: string;
  prefix?: string;
  timeoutMs?: number;
  transport?: MCPTransport;
  url: string;
}

export interface MCPTool {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  originalName: string;
  server: string;
}

export interface MCPCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface JsonRpcRequest {
  id: string;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  error?: { code: number; data?: unknown; message: string };
  id: string;
  jsonrpc: "2.0";
  result?: unknown;
}

interface SSESession {
  eventSource: EventSource;
  messageUrl: string;
  pending: Map<string, {
    reject: (err: Error) => void;
    resolve: (result: unknown) => void;
  }>;
}

function requestId(): string {
  return crypto.randomUUID();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MCPClient {
  private readonly sseSessions = new Map<string, SSESession>();

  constructor(private readonly servers: MCPServerConfig[]) {}

  async listTools(): Promise<MCPTool[]> {
    const results = await Promise.allSettled(
      this.servers.map((server) => this.listToolsFromServer(server)),
    );

    const tools: MCPTool[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        tools.push(...result.value);
      } else {
        console.warn(`[mcp] failed to list tools from "${this.servers[index].name}": ${toMessage(result.reason)}`);
      }
    }

    return tools;
  }

  async call(sanitizedToolName: string, input: unknown): Promise<MCPCallResult> {
    const server = this.resolveServer(sanitizedToolName);
    const originalName = this.originalToolName(sanitizedToolName, server);
    const result = await this.rpc(server, "tools/call", {
      arguments: input,
      name: originalName,
    });

    return result as MCPCallResult;
  }

  dispose(): void {
    for (const session of this.sseSessions.values()) {
      session.eventSource.close();
    }
    this.sseSessions.clear();
  }

  private async listToolsFromServer(server: MCPServerConfig): Promise<MCPTool[]> {
    const response = await this.rpc(server, "tools/list", {});
    const payload = response as {
      tools?: Array<{ description?: string; inputSchema?: unknown; name: string }>;
    };

    return (payload.tools ?? []).map((tool) => {
      const prefix = server.prefix ? `${server.prefix}_` : "";
      return {
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
        name: sanitizeToolName(`${prefix}${tool.name}`),
        originalName: tool.name,
        server: server.name,
      };
    });
  }

  private async rpc(server: MCPServerConfig, method: string, params: unknown): Promise<unknown> {
    if ((server.transport ?? "streamable-http") === "sse") {
      return this.rpcSSE(server, method, params);
    }

    return this.rpcStreamableHTTP(server, method, params);
  }

  private async rpcStreamableHTTP(server: MCPServerConfig, method: string, params: unknown): Promise<unknown> {
    const id = requestId();
    const body: JsonRpcRequest = {
      id,
      jsonrpc: "2.0",
      method,
      params,
    };

    const fetchImpl = server.fetchImpl ?? fetch;
    const response = await fetchImpl(server.url, {
      body: JSON.stringify(body),
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(server.authToken ? { Authorization: `Bearer ${server.authToken}` } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(server.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status} from "${server.name}": ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = await response.json() as JsonRpcResponse;
      if (json.error) {
        throw new Error(`MCP RPC error: ${json.error.message}`);
      }
      return json.result;
    }

    if (contentType.includes("text/event-stream")) {
      return this.collectSSEResponse(response, id);
    }

    throw new Error(`Unexpected content-type "${contentType}" from "${server.name}"`);
  }

  private async collectSSEResponse(response: Response, targetId: string): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("SSE response missing body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("SSE stream ended before response received");
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const json = JSON.parse(data) as JsonRpcResponse;
          if (String(json.id) === targetId) {
            reader.cancel();
            if (json.error) {
              throw new Error(`MCP RPC error: ${json.error.message}`);
            }
            return json.result;
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
  }

  private async ensureSSESession(server: MCPServerConfig): Promise<SSESession> {
    const existing = this.sseSessions.get(server.name);
    if (existing) return existing;

    const sseUrl = server.url.replace(/\/?$/, "").replace(/\/mcp$/, "") + "/sse";
    const eventSourceFactory = server.eventSourceFactory ?? ((url) => new EventSource(url));

    return new Promise<SSESession>((resolve, reject) => {
      const pending = new Map<string, {
        reject: (err: Error) => void;
        resolve: (result: unknown) => void;
      }>();

      const eventSource = eventSourceFactory(sseUrl);
      const session: SSESession = {
        eventSource,
        messageUrl: "",
        pending,
      };

      const timer = setTimeout(() => {
        eventSource.close();
        reject(new Error(`SSE connection to "${server.name}" timed out`));
      }, 10_000);

      eventSource.addEventListener("endpoint", (event: Event) => {
        clearTimeout(timer);
        session.messageUrl = (event as MessageEvent).data as string;
        this.sseSessions.set(server.name, session);
        resolve(session);
      });

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const json = JSON.parse(event.data as string) as JsonRpcResponse;
          const pendingEntry = pending.get(String(json.id));
          if (!pendingEntry) return;

          pending.delete(String(json.id));
          if (json.error) {
            pendingEntry.reject(new Error(json.error.message));
          } else {
            pendingEntry.resolve(json.result);
          }
        } catch {
          // ignore non-json events
        }
      };

      eventSource.onerror = () => {
        this.sseSessions.delete(server.name);
        reject(new Error(`SSE error from "${server.name}"`));
      };
    });
  }

  private async rpcSSE(server: MCPServerConfig, method: string, params: unknown): Promise<unknown> {
    const session = await this.ensureSSESession(server);
    const id = requestId();
    const body: JsonRpcRequest = {
      id,
      jsonrpc: "2.0",
      method,
      params,
    };
    const fetchImpl = server.fetchImpl ?? fetch;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`RPC "${method}" on "${server.name}" timed out`));
      }, server.timeoutMs ?? 30_000);

      session.pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });

      fetchImpl(session.messageUrl, {
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          ...(server.authToken ? { Authorization: `Bearer ${server.authToken}` } : {}),
        },
        method: "POST",
      }).catch((error) => {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private resolveServer(sanitizedToolName: string): MCPServerConfig {
    for (const server of this.servers) {
      const prefix = server.prefix ? `${server.prefix}_` : "";
      if (sanitizedToolName.startsWith(prefix)) {
        return server;
      }
    }

    throw new Error(`No MCP server found for tool "${sanitizedToolName}"`);
  }

  private originalToolName(sanitizedToolName: string, server: MCPServerConfig): string {
    const prefix = server.prefix ? `${server.prefix}_` : "";
    return sanitizedToolName.slice(prefix.length);
  }
}

export function defaultServersFromEnv(env: Record<string, string | undefined>): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [];

  if (env.MCP_CONTEXT7_URL) {
    servers.push({
      authToken: env.GATEWAY_AUTH_TOKEN,
      name: "context7",
      prefix: "ctx7",
      timeoutMs: 20_000,
      transport: "streamable-http",
      url: env.MCP_CONTEXT7_URL,
    });
  }

  if (env.MCP_CLOUDFLARE_URL) {
    servers.push({
      authToken: env.CF_API_TOKEN,
      name: "cloudflare",
      prefix: "cf",
      timeoutMs: 30_000,
      transport: "streamable-http",
      url: env.MCP_CLOUDFLARE_URL,
    });
  }

  return servers;
}
