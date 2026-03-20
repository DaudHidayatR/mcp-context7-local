import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MCPClient } from "../packages/mcp-client/src/index";
import { createGatewayApp, type GatewayApp } from "../services/context7-gateway/src/index";

const fixturePath = join(import.meta.dir, "fixtures", "fake-stdio-mcp.ts");
const bunPath = Bun.which("bun") ?? "bun";
const baseUrl = "http://gateway.test";
const originalEnv = {
  CLIENT_IP_ENCRYPTION_KEY: Bun.env.CLIENT_IP_ENCRYPTION_KEY,
  CONTEXT7_API_KEY: Bun.env.CONTEXT7_API_KEY,
};

let gateway: GatewayApp | null = null;

function gatewayFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request
    ? input
    : new Request(typeof input === "string" ? input : input.toString(), init);
  return gateway!.fetch(request);
}

function startGateway() {
  gateway = createGatewayApp({
    authToken: "",
    childCommand: [bunPath, fixturePath],
    childEnvAllowlist: ["CONTEXT7_API_KEY", "CLIENT_IP_ENCRYPTION_KEY"],
    port: 3100,
    requestTimeoutMs: 100,
    sessionTimeoutMs: 1_000,
  });
}

beforeEach(() => {
  Bun.env.CONTEXT7_API_KEY = "allowed-key";
  Bun.env.CLIENT_IP_ENCRYPTION_KEY = "allowed-encryption-key";
});

afterEach(() => {
  gateway?.stop();
  gateway = null;
  Bun.env.CONTEXT7_API_KEY = originalEnv.CONTEXT7_API_KEY;
  Bun.env.CLIENT_IP_ENCRYPTION_KEY = originalEnv.CLIENT_IP_ENCRYPTION_KEY;
});

describe("mcp client", () => {
  test("lists prefixed tools over streamable http", async () => {
    startGateway();

    const client = new MCPClient([{
      fetchImpl: gatewayFetch,
      name: "context7",
      prefix: "ctx7",
      transport: "streamable-http",
      url: new URL("/mcp", baseUrl).toString(),
    }]);

    const tools = await client.listTools();
    expect(tools[0].name).toBe("ctx7_fixture_tool");
    expect(tools[0].originalName).toBe("fixture_tool");
  });

  test("calls a tool over streamable http", async () => {
    startGateway();

    const client = new MCPClient([{
      fetchImpl: gatewayFetch,
      name: "context7",
      prefix: "ctx7",
      transport: "streamable-http",
      url: new URL("/mcp", baseUrl).toString(),
    }]);

    const result = await client.call("ctx7_fixture_tool", { foo: "bar" });
    expect(result.content[0].text).toContain("\"name\":\"fixture_tool\"");
    expect(result.content[0].text).toContain("\"foo\":\"bar\"");
  });
});
