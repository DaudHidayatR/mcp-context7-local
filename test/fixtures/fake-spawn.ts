import { spawn } from "bun";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeSpawnOptions {
  cmd: string[];
  env?: Record<string, string>;
  stderr?: "pipe";
  stdin?: "pipe";
  stdout?: "pipe";
}

interface ControlledReadable {
  close: () => void;
  enqueue: (text: string) => void;
  stream: ReadableStream<Uint8Array>;
}

interface FakeJsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function createControlledReadable(): ControlledReadable {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  return {
    close: () => {
      if (closed || !controller) return;
      closed = true;
      controller.close();
    },
    enqueue: (text: string) => {
      if (closed || !controller) return;
      controller.enqueue(encoder.encode(text));
    },
    stream: new ReadableStream<Uint8Array>({
      start: (nextController) => {
        controller = nextController;
      },
    }),
  };
}

function normalizeRawResponse(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createFakeSpawn(responses: string[] = []): typeof spawn {
  const queuedResponses = [...responses];
  let nextPid = 10_000;

  return ((options: FakeSpawnOptions | string[]) => {
    if (!options || Array.isArray(options)) {
      throw new Error("createFakeSpawn only supports object-style spawn options");
    }

    const stdout = createControlledReadable();
    const stderr = createControlledReadable();
    const childEnv = { ...(options.env ?? {}) };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let bufferedInput = "";
    let didInitialize = false;
    let exitCode: number | null = null;
    let resolveExited!: (code: number) => void;

    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });

    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };

    const finish = (code: number) => {
      if (exitCode !== null) return;
      exitCode = code;
      clearTimers();
      stdout.close();
      stderr.close();
      resolveExited(code);
    };

    const schedule = (fn: () => void, delay = 0) => {
      if (exitCode !== null) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delay);
      timers.add(timer);
    };

    const sendPayload = (payload: unknown) => {
      if (exitCode !== null) return;
      stdout.enqueue(`${JSON.stringify(payload)}\n`);
    };

    const sendQueuedResponse = () => {
      const next = queuedResponses.shift();
      if (!next) return false;

      for (const line of normalizeRawResponse(next)) {
        stdout.enqueue(`${line}\n`);
      }
      return true;
    };

    const handleRequest = (line: string) => {
      if (sendQueuedResponse()) return;

      let request: FakeJsonRpcRequest;
      try {
        request = JSON.parse(line) as FakeJsonRpcRequest;
      } catch {
        return;
      }

      if (typeof request.method !== "string" || request.method.length === 0) return;

      if (request.method === "notifications/initialized" && request.id === undefined) {
        return;
      }

      if (request.id === undefined || request.id === null) return;

      if (request.method === "initialize") {
        didInitialize = true;
        sendPayload({
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
        return;
      }

      if (request.method === "tools/list") {
        if (childEnv.REQUIRE_INITIALIZE === "1" && !didInitialize) {
          sendPayload({
            error: {
              code: -32002,
              message: "tools/list requires a prior initialize on the same session",
            },
            id: request.id,
            jsonrpc: "2.0",
          });
          return;
        }

        sendPayload({
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
        return;
      }

      if (request.method === "tools/call") {
        if (childEnv.REQUIRE_INITIALIZE === "1" && !didInitialize) {
          sendPayload({
            error: {
              code: -32003,
              message: "tools/call requires a prior initialize on the same session",
            },
            id: request.id,
            jsonrpc: "2.0",
          });
          return;
        }

        sendPayload({
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
        return;
      }

      if (request.method === "test/env") {
        sendPayload({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            env: {
              CLIENT_IP_ENCRYPTION_KEY: childEnv.CLIENT_IP_ENCRYPTION_KEY ?? null,
              CONTEXT7_API_KEY: childEnv.CONTEXT7_API_KEY ?? null,
              SECRET_TOKEN: childEnv.SECRET_TOKEN ?? null,
            },
          },
        });
        return;
      }

      if (request.method === "test/sleep") {
        const durationMs = Number(request.params?.durationMs ?? 0);
        schedule(() => {
          sendPayload({
            id: request.id,
            jsonrpc: "2.0",
            result: { sleptMs: durationMs },
          });
        }, durationMs);
        return;
      }

      if (request.method === "test/exit") {
        const requestedExitCode = Number(request.params?.exitCode ?? 17);
        schedule(() => finish(requestedExitCode));
        return;
      }

      sendPayload({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          echo: request.params ?? null,
          method: request.method,
        },
      });
    };

    if (childEnv.STARTUP_NOTICE === "1") {
      schedule(() => {
        sendPayload({
          jsonrpc: "2.0",
          method: "notice",
          params: { ready: true },
        });
      });
    }

    const proc = {
      stderr: stderr.stream,
      stdin: {
        end: () => undefined,
        flush: () => {
          const lines = bufferedInput.split("\n");
          bufferedInput = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            handleRequest(line);
          }

          return 0;
        },
        ref: () => undefined,
        start: () => undefined,
        unref: () => undefined,
        write: (chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer) => {
          let decodedChunk: string;
          if (typeof chunk === "string") {
            decodedChunk = chunk;
          } else if (chunk instanceof ArrayBuffer) {
            decodedChunk = decoder.decode(new Uint8Array(chunk), { stream: true });
          } else if (chunk instanceof SharedArrayBuffer) {
            decodedChunk = decoder.decode(new Uint8Array(chunk), { stream: true });
          } else {
            decodedChunk = decoder.decode(chunk, { stream: true });
          }

          bufferedInput += decodedChunk;
          return 0;
        },
      },
      stdout: stdout.stream,
      exited,
      exitCode,
      killed: false,
      pid: nextPid++,
      readable: stdout.stream,
      resourceUsage: () => undefined,
      signalCode: null,
      stdio: [null, null, null] as [null, null, null],
      terminal: undefined,
      ref: () => undefined,
      unref: () => undefined,
      send: () => undefined,
      disconnect: () => undefined,
      kill: (code?: number | NodeJS.Signals) => {
        finish(typeof code === "number" ? code : 0);
      },
      [Symbol.asyncDispose]: async () => {
        finish(0);
      },
    };

    Object.defineProperties(proc, {
      exitCode: {
        get: () => exitCode,
      },
      killed: {
        get: () => exitCode !== null,
      },
    });

    return proc as unknown as Bun.PipedSubprocess;
  }) as typeof spawn;
}
