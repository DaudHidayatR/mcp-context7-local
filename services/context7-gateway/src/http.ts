import type { GatewayConfig } from "./config";
import type { SessionManager } from "./session-manager";
import { parseJsonRpcId } from "./session-manager";

interface ParsedJsonRpcBody {
  id: string | null;
  method: string;
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    status,
  });
}

function sseHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
    ...extra,
  };
}

function isAuthorized(req: Request, authToken: string): boolean {
  return !authToken || req.headers.get("authorization") === `Bearer ${authToken}`;
}

function parseJsonRpcBody(body: string): ParsedJsonRpcBody {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON-RPC body");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON-RPC body");
  }

  const method = (parsed as { method?: unknown }).method;
  if (typeof method !== "string" || method.length === 0) {
    throw new Error("Invalid JSON-RPC method");
  }

  return {
    id: parseJsonRpcId(body),
    method,
  };
}

function unauthorizedResponse(): Response {
  return jsonResponse({ error: "Unauthorized" }, 401);
}

function notFoundResponse(): Response {
  return jsonResponse({ error: "Not found" }, 404);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logRequest(details: Record<string, unknown>): void {
  console.log(`[gateway] ${JSON.stringify({ event: "request", ...details })}`);
}

function sessionLabel(id: string | null): string | null {
  return id ? id.slice(0, 8) : null;
}

export function createGatewayFetch(
  config: GatewayConfig,
  manager: SessionManager,
  startedAt: number,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return jsonResponse({
        sessions: manager.sessionCount(),
        startedAt,
        status: "ok",
      });
    }

    if (!isAuthorized(req, config.authToken)) {
      return unauthorizedResponse();
    }

    if (url.pathname === "/sse" && req.method === "GET") {
      const session = manager.getOrCreate();
      const stream = manager.createLegacyStream(
        session,
        `${url.origin}/message?sessionId=${session.id}`,
      );

      return new Response(stream, {
        headers: sseHeaders({ "X-Session-Id": session.id }),
      });
    }

    if (url.pathname === "/message" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return jsonResponse({ error: "Missing sessionId" }, 400);
      }

      const session = manager.get(sessionId);
      if (!session) {
        return jsonResponse({ error: "Session not found" }, 404);
      }

      await manager.write(session, await req.text());
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/mcp" && req.method === "DELETE") {
      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId) manager.destroy(sessionId);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/mcp" && req.method === "POST") {
      const requestStartedAt = Date.now();
      const requestedSessionId = req.headers.get("mcp-session-id");
      const body = await req.text();
      const accept = req.headers.get("accept") ?? "";
      const transport = accept.includes("text/event-stream") ? "streamable-http-sse" : "streamable-http-json";

      let createdSession = false;
      let error: string | null = null;
      let rpcId: string | null = null;
      let rpcMethod = "unknown";
      let responseStatus = 500;
      let sessionId: string | null = requestedSessionId;

      const finalize = (response: Response): Response => {
        responseStatus = response.status;
        return response;
      };

      try {
        const parsed = parseJsonRpcBody(body);
        rpcId = parsed.id;
        rpcMethod = parsed.method;

        const existingSession = requestedSessionId ? manager.get(requestedSessionId) : undefined;
        const session = existingSession ?? manager.getOrCreate(requestedSessionId ?? undefined);
        createdSession = requestedSessionId ? !existingSession : true;
        sessionId = session.id;
        const preservesStartupSession = !requestedSessionId && rpcMethod === "initialize";
        const isEphemeral = !requestedSessionId && !preservesStartupSession;

        if (rpcId === null) {
          await manager.write(session, body);
          if (isEphemeral) manager.destroy(session.id);
          return finalize(new Response(null, {
            headers: { "Mcp-Session-Id": session.id },
            status: 202,
          }));
        }

        if (accept.includes("text/event-stream")) {
          const stream = manager.createRpcStream(session, {
            destroyOnClose: isEphemeral,
            targetRpcId: rpcId,
          });

          await manager.write(session, body);
          return finalize(new Response(stream, {
            headers: sseHeaders({ "Mcp-Session-Id": session.id }),
          }));
        }

        const responseLine = await manager.writeAndAwait(session, body, rpcId, {
          destroyOnTimeoutBeforeResponse: createdSession,
        });
        if (isEphemeral) manager.destroy(session.id);

        return finalize(new Response(responseLine, {
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": session.id,
          },
        }));
      } catch (caughtError) {
        error = errorMessage(caughtError);
        const isBadRequest = error === "Invalid JSON-RPC body" || error === "Invalid JSON-RPC method";
        if (sessionId && createdSession) {
          manager.destroy(sessionId);
        }

        return finalize(jsonResponse({
          error: {
            code: -32603,
            message: error,
          },
          id: rpcId,
          jsonrpc: "2.0",
        }, isBadRequest ? 400 : 504));
      } finally {
        logRequest({
          createdSession,
          durationMs: Date.now() - requestStartedAt,
          error,
          method: rpcMethod,
          rpcId,
          sessionId: sessionLabel(sessionId),
          status: responseStatus,
          transport,
        });
      }
    }

    return notFoundResponse();
  };
}

export function internalServerErrorResponse(): Response {
  return jsonResponse({ error: "Internal server error" }, 500);
}
