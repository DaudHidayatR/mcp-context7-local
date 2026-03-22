#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const RUNNER_REFRESH_URL = "http://127.0.0.1:3200/refresh-namespace";
const MEMORY_FALLBACK_URL = "http://127.0.0.1:8082";
const USAGE = 'Usage: bun run scripts/create-project.ts <namespace> [--name "Display Name"] [--local]';

export interface CreateProjectArgs {
  displayName?: string;
  local: boolean;
  namespace: string;
}

export interface CreateProjectEnv {
  chromaUrl: string;
  gatewayAuthToken?: string;
  memoryUrl?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RunCreateProjectOptions {
  cwd?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

function trimQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function isValidNamespace(namespace: string): boolean {
  return /^[a-z0-9-]+$/.test(namespace) && namespace.length >= 3 && namespace.length <= 40;
}

export function parseCreateProjectArgs(argv: string[]): CreateProjectArgs {
  const positionals: string[] = [];
  let displayName: string | undefined;
  let local = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local") {
      local = true;
      continue;
    }

    if (arg === "--name") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--name requires a value");
      }
      displayName = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    positionals.push(arg);
  }

  if (positionals.length !== 1) {
    throw new Error(USAGE);
  }

  const namespace = positionals[0];
  if (!isValidNamespace(namespace)) {
    throw new Error("namespace must match /^[a-z0-9-]+$/ and be 3-40 chars");
  }

  return { displayName, local, namespace };
}

function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    const value = trimQuotes(normalized.slice(separatorIndex + 1).trim());
    values[key] = value;
  }

  return values;
}

export async function loadCreateProjectEnv(cwd = process.cwd()): Promise<CreateProjectEnv> {
  const envPath = join(cwd, ".env");
  let contents: string;

  try {
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${envPath}: ${detail}`);
  }

  const values = parseDotEnv(contents);
  const chromaUrl = values.CHROMA_URL?.trim();
  if (!chromaUrl) {
    throw new Error("CHROMA_URL is required in .env");
  }

  const gatewayAuthToken = values.GATEWAY_AUTH_TOKEN?.trim() || undefined;
  const memoryUrl = values.VPS_MEMORY_URL?.trim() || undefined;

  return {
    chromaUrl,
    gatewayAuthToken,
    memoryUrl,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildRunnerHeaders(gatewayAuthToken?: string): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (gatewayAuthToken) {
    headers.Authorization = `Bearer ${gatewayAuthToken}`;
  }

  return headers;
}

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: FetchLike,
  headers?: HeadersInit,
): Promise<void> {
  const response = await fetchImpl(url, {
    body: JSON.stringify(body),
    headers: headers ?? { "Content-Type": "application/json" },
    method: "POST",
  });

  if (response.ok) {
    return;
  }

  const responseBody = await response.text();
  const detail = responseBody.trim() || response.statusText || "request failed";
  throw new Error(`${url} returned ${response.status}: ${detail}`);
}

export function formatManualChecklist(namespace: string, displayName: string): string[] {
  const metaPayload = JSON.stringify({ name: displayName });
  const goalsPayload = JSON.stringify({ primary: "..." });

  return [
    "[ ] Populate KV sections via wrangler (if using CF worker):",
    `    wrangler kv key put --binding=PRD_KV "${namespace}:prd:meta" '${metaPayload}'`,
    `    wrangler kv key put --binding=PRD_KV "${namespace}:prd:goals" '${goalsPayload}'`,
    "[ ] Add namespace to registry:projects KV key",
    `[ ] Set up RAG corpus: add docs to memory/${namespace}/ and run /refresh`,
  ];
}

export async function runCreateProject(
  argv: string[],
  options: RunCreateProjectOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((message: string) => console.log(message));
  const stderr = options.stderr ?? ((message: string) => console.error(message));

  try {
    const args = parseCreateProjectArgs(argv);
    const envConfig = await loadCreateProjectEnv(cwd);
    const displayName = args.displayName ?? args.namespace;

    if (!args.local) {
      await postJson(
        RUNNER_REFRESH_URL,
        { namespace: args.namespace },
        fetchImpl,
        buildRunnerHeaders(envConfig.gatewayAuthToken),
      );

      await postJson(
        `${trimTrailingSlash(envConfig.memoryUrl ?? MEMORY_FALLBACK_URL)}/write`,
        {
          key: "init",
          namespace: args.namespace,
          scope: "project",
          tags: ["init"],
          value: {
            created: now().toISOString(),
            name: displayName,
          },
        },
        fetchImpl,
      );
    }

    for (const line of formatManualChecklist(args.namespace, displayName)) {
      stdout(line);
    }

    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCreateProject(process.argv.slice(2));
  process.exit(code);
}
