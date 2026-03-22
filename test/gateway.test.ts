import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../services/context7-gateway/src/index";
import { createFakeSpawn } from "./fixtures/fake-spawn";

const fixturePath = join(import.meta.dir, "fixtures", "fake-stdio-mcp.ts");
const bunPath = Bun.which("bun") ?? "bun";
const baseUrl = "http://gateway.test";
const originalEnv = {
  CLIENT_IP_ENCRYPTION_KEY: Bun.env.CLIENT_IP_ENCRYPTION_KEY,
  CONTEXT7_API_KEY: Bun.env.CONTEXT7_API_KEY,
  REQUIRE_INITIALIZE: Bun.env.REQUIRE_INITIALIZE,
  SECRET_TOKEN: Bun.env.SECRET_TOKEN,
};

let gateway: GatewayApp | null = null;

async function gatewayFetch(pathOrUrl: string, init?: RequestInit): Promise<Response> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : new URL(pathOrUrl, baseUrl).toString();
  return gateway!.fetch(new Request(url, init));
}

async function readSseMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE stream ended before receiving a message");

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split("\n\n");
    buffer = segments.pop() ?? "";

    for (const segment of segments) {
      if (segment.includes("data: ")) {
        return segment;
      }
    }
  }
}

function startGateway(overrides: Partial<Parameters<typeof createGatewayApp>[0]> = {}) {
  gateway = createGatewayApp({
    authToken: "",
    childCommand: [bunPath, fixturePath],
    childEnvAllowlist: ["CONTEXT7_API_KEY", "CLIENT_IP_ENCRYPTION_KEY"],
    port: 3100,
    requestTimeoutMs: 100,
    sessionTimeoutMs: 1_000,
    ...overrides,
  }, Bun.env, createFakeSpawn());
}

beforeEach(() => {
  Bun.env.CONTEXT7_API_KEY = "allowed-key";
  Bun.env.CLIENT_IP_ENCRYPTION_KEY = "allowed-encryption-key";
  Bun.env.SECRET_TOKEN = "blocked-secret";
});

afterEach(() => {
  gateway?.stop();
  gateway = null;
  Bun.env.CONTEXT7_API_KEY = originalEnv.CONTEXT7_API_KEY;
  Bun.env.CLIENT_IP_ENCRYPTION_KEY = originalEnv.CLIENT_IP_ENCRYPTION_KEY;
  Bun.env.REQUIRE_INITIALIZE = originalEnv.REQUIRE_INITIALIZE;
  Bun.env.SECRET_TOKEN = originalEnv.SECRET_TOKEN;
});

describe("gateway", () => {
  test("keeps /health unauthenticated while protecting MCP endpoints", async () => {
    startGateway({ authToken: "secret-token" });

    const healthResponse = await gatewayFetch("/health");
    expect(healthResponse.status).toBe(200);

    const unauthorizedResponse = await gatewayFetch("/sse");
    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await gatewayFetch("/sse", {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(authorizedResponse.status).toBe(200);
  });

  test("supports legacy SSE sessions", async () => {
    startGateway();

    const sseResponse = await gatewayFetch("/sse");
    expect(sseResponse.status).toBe(200);
    const reader = sseResponse.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");

    const endpointChunk = await readSseMessage(reader);
    const endpoint = endpointChunk.split("data: ")[1]?.trim();
    expect(endpoint).toContain("/message?sessionId=");

    const messageResponse = await gatewayFetch(endpoint!, {
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(messageResponse.status).toBe(202);

    const resultChunk = await readSseMessage(reader);
    expect(resultChunk).toContain("fixture_tool");
  });

  test("supports JSON /mcp requests", async () => {
    startGateway();

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeTruthy();

    const payload = await response.json();
    expect(payload.result.tools[0].name).toBe("fixture_tool");
  });

  test("supports SSE /mcp responses", async () => {
    startGateway();

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "stream-1", jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    const chunk = await readSseMessage(reader);
    expect(chunk).toContain("fixture_tool");
  });

  test("returns 202 for notification /mcp requests even when SSE is accepted", async () => {
    startGateway();

    const initResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({
        id: "init-1",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    const initializedResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      method: "POST",
    });

    expect(initializedResponse.status).toBe(202);
    expect(initializedResponse.headers.get("Content-Type")).toBeNull();
    expect(initializedResponse.headers.get("Mcp-Session-Id")).toBe(sessionId);
  });

  test("keeps the initialize session alive across initialized and tools/list", async () => {
    Bun.env.REQUIRE_INITIALIZE = "1";
    startGateway({
      childEnvAllowlist: ["CONTEXT7_API_KEY", "CLIENT_IP_ENCRYPTION_KEY", "REQUIRE_INITIALIZE"],
    });

    const initResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({
        id: "init-persist",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1.0.0" },
          protocolVersion: "2025-03-26",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    const initReader = initResponse.body?.getReader();
    if (!initReader) throw new Error("Missing initialize SSE body");
    const initChunk = await readSseMessage(initReader);
    expect(initChunk).toContain("\"protocolVersion\"");
    await initReader.cancel();

    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(1);

    const initializedResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      method: "POST",
    });

    expect(initializedResponse.status).toBe(202);
    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(1);

    const toolsResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({
        id: "tools-after-init",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId!,
      },
      method: "POST",
    });

    expect(toolsResponse.status).toBe(200);
    const toolsReader = toolsResponse.body?.getReader();
    if (!toolsReader) throw new Error("Missing tools/list SSE body");
    const toolsChunk = await readSseMessage(toolsReader);
    expect(toolsChunk).toContain("fixture_tool");
    await toolsReader.cancel();
  });

  test("reuses explicit /mcp sessions and tears them down", async () => {
    startGateway();

    const sessionId = "session-reuse";

    const firstResponse = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      },
      method: "POST",
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("Mcp-Session-Id")).toBe(sessionId);

    const healthAfterCreate = await (await gatewayFetch("/health")).json();
    expect(healthAfterCreate.sessions).toBe(1);

    const deleteResponse = await gatewayFetch("/mcp", {
      headers: { "Mcp-Session-Id": sessionId },
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    const healthAfterDelete = await (await gatewayFetch("/health")).json();
    expect(healthAfterDelete.sessions).toBe(0);
  });

  test("returns 504 on request timeout", async () => {
    startGateway({ requestTimeoutMs: 20 });

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "slow", jsonrpc: "2.0", method: "test/sleep", params: { durationMs: 100 } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(504);
    const payload = await response.json();
    expect(payload.error.message).toContain("before the child produced any stdout");
    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(0);
  });

  test("destroys newly created explicit sessions after an initial timeout", async () => {
    startGateway({ requestTimeoutMs: 20 });

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "slow-explicit", jsonrpc: "2.0", method: "test/sleep", params: { durationMs: 100 } }),
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "fresh-timeout-session",
      },
      method: "POST",
    });

    expect(response.status).toBe(504);
    const payload = await response.json();
    expect(payload.error.message).toContain("before the child produced any stdout");
    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(0);
  });

  test("returns a child-exit error when the child exits before responding", async () => {
    startGateway({ requestTimeoutMs: 100 });

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "exit", jsonrpc: "2.0", method: "test/exit", params: { exitCode: 23 } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(504);
    const payload = await response.json();
    expect(payload.error.message).toContain("child exited with code 23");
    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(0);
  });

  test("reaps idle sessions", async () => {
    startGateway({ sessionTimeoutMs: 60 });

    await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "idle-session",
      },
      method: "POST",
    });

    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(1);
    await Bun.sleep(140);
    expect((await (await gatewayFetch("/health")).json()).sessions).toBe(0);
  });

  test("allowlists child environment variables", async () => {
    startGateway();

    const response = await gatewayFetch("/mcp", {
      body: JSON.stringify({ id: "env", jsonrpc: "2.0", method: "test/env", params: {} }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.env.CONTEXT7_API_KEY).toBe("allowed-key");
    expect(payload.result.env.CLIENT_IP_ENCRYPTION_KEY).toBe("allowed-encryption-key");
    expect(payload.result.env.SECRET_TOKEN).toBeNull();
  });
});
