const DEFAULT_CHILD_COMMAND = [
  "bun",
  "run",
  "node_modules/.bun/node_modules/@upstash/context7-mcp/dist/index.js",
];

export interface GatewayConfig {
  authToken: string;
  childCommand: string[];
  childEnvAllowlist: string[];
  port: number;
  requestTimeoutMs: number;
  sessionTimeoutMs: number;
}

function parseIntEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseChildCommand(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_CHILD_COMMAND];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STDIO_CMD_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("STDIO_CMD_JSON must be a non-empty JSON string array");
  }

  return [...parsed];
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  return {
    authToken: env.GATEWAY_AUTH_TOKEN ?? "",
    childCommand: parseChildCommand(env.STDIO_CMD_JSON),
    childEnvAllowlist: (env.CHILD_ENV_ALLOWLIST ?? "CONTEXT7_API_KEY,CLIENT_IP_ENCRYPTION_KEY")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
    port: parseIntEnv(env.GATEWAY_PORT, 3100, "GATEWAY_PORT"),
    requestTimeoutMs: parseIntEnv(env.REQUEST_TIMEOUT_MS, 30_000, "REQUEST_TIMEOUT_MS"),
    sessionTimeoutMs: parseIntEnv(env.SESSION_TIMEOUT_MS, 300_000, "SESSION_TIMEOUT_MS"),
  };
}
