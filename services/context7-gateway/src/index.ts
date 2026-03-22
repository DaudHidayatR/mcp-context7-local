import { loadConfig, type GatewayConfig } from "./config";
import { createGatewayFetch, internalServerErrorResponse } from "./http";
import { spawn } from "bun";
import { SessionManager } from "./session-manager";

export interface GatewayHandle {
  baseUrl: string;
  config: GatewayConfig;
  manager: SessionManager;
  server: Bun.Server<undefined>;
  stop: () => void;
}

export interface GatewayApp {
  config: GatewayConfig;
  fetch: (req: Request) => Promise<Response>;
  manager: SessionManager;
  startedAt: number;
  stop: () => void;
}

export function createGatewayApp(
  config = loadConfig(Bun.env),
  env: Record<string, string | undefined> = Bun.env,
  spawnFn: typeof spawn = spawn,
): GatewayApp {
  const manager = new SessionManager(config, env, spawnFn);
  const startedAt = Date.now();

  return {
    config,
    fetch: createGatewayFetch(config, manager, startedAt),
    manager,
    startedAt,
    stop: () => manager.shutdown(),
  };
}

export function createGatewayServer(
  config = loadConfig(Bun.env),
  env: Record<string, string | undefined> = Bun.env,
  spawnFn: typeof spawn = spawn,
): GatewayHandle {
  const app = createGatewayApp(config, env, spawnFn);

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    error: (error) => {
      console.error("[gateway] unhandled error:", error);
      return internalServerErrorResponse();
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    config: app.config,
    manager: app.manager,
    server,
    stop: () => {
      app.stop();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const handle = createGatewayServer();

  console.log(`[gateway] listening on :${handle.server.port}`);
  console.log(`[gateway] child cmd: ${handle.config.childCommand.join(" ")}`);
  console.log(`[gateway] auth: ${handle.config.authToken ? "enabled" : "disabled"}`);

  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
