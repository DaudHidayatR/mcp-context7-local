export {};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.env.STARTUP_NOTICE === "1") {
  send({
    jsonrpc: "2.0",
    method: "notice",
    params: { ready: true },
  });
}

let buffer = "";
let didInitialize = false;

const reader = Bun.stdin.stream().getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = value;
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    if (request.id === undefined || request.method === undefined) {
      continue;
    }

    if (request.method === "initialize") {
      didInitialize = true;
      send({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities: {
            tools: { listChanged: true },
          },
          instructions: "Fixture MCP server",
          protocolVersion: "2025-03-26",
          serverInfo: {
            name: "fixture",
            version: "1.0.0",
          },
        },
      });
      continue;
    }

    if (request.method === "notifications/initialized") {
      if (process.env.REQUIRE_INITIALIZE === "1" && !didInitialize) {
        send({
          error: {
            code: -32001,
            message: "initialize must be called before notifications/initialized",
          },
          id: request.id ?? null,
          jsonrpc: "2.0",
        });
        continue;
      }

      continue;
    }

    if (request.method === "tools/list") {
      if (process.env.REQUIRE_INITIALIZE === "1" && !didInitialize) {
        send({
          error: {
            code: -32002,
            message: "tools/list requires a prior initialize on the same session",
          },
          id: request.id,
          jsonrpc: "2.0",
        });
        continue;
      }

      send({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: [
            {
              description: "Fake fixture tool",
              inputSchema: { type: "object" },
              name: "fixture_tool",
            },
          ],
        },
      });
      continue;
    }

    if (request.method === "tools/call") {
      if (process.env.REQUIRE_INITIALIZE === "1" && !didInitialize) {
        send({
          error: {
            code: -32003,
            message: "tools/call requires a prior initialize on the same session",
          },
          id: request.id,
          jsonrpc: "2.0",
        });
        continue;
      }

      send({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: JSON.stringify(request.params ?? {}),
              type: "text",
            },
          ],
        },
      });
      continue;
    }

    if (request.method === "test/env") {
      send({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          env: {
            CLIENT_IP_ENCRYPTION_KEY: process.env.CLIENT_IP_ENCRYPTION_KEY ?? null,
            CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY ?? null,
            SECRET_TOKEN: process.env.SECRET_TOKEN ?? null,
          },
        },
      });
      continue;
    }

    if (request.method === "test/sleep") {
      const durationMs = Number(request.params?.durationMs ?? 0);
      await Bun.sleep(durationMs);
      send({
        id: request.id,
        jsonrpc: "2.0",
        result: { sleptMs: durationMs },
      });
      continue;
    }

    if (request.method === "test/exit") {
      const exitCode = Number(request.params?.exitCode ?? 17);
      process.exit(exitCode);
    }

    send({
      id: request.id,
      jsonrpc: "2.0",
      result: {
        echo: request.params ?? null,
        method: request.method,
      },
    });
  }
}
