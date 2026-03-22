import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SETUP_USAGE = 'Usage: bun run scripts/setup-project.ts <namespace> [--name "Display Name"] [--local]';
const CREATE_USAGE = 'Usage: bun run scripts/create-project.ts <namespace> [--name "Display Name"] [--local]';
const RUNNER_REFRESH_URL = "http://127.0.0.1:3200/refresh-namespace";
const MEMORY_FALLBACK_URL = "http://127.0.0.1:8082";

export interface ProjectBootstrapArgs {
  displayName?: string;
  local: boolean;
  namespace: string;
}

export interface ProjectBootstrapEnv {
  gatewayAuthToken?: string;
  memoryUrl?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProjectBootstrapOptions {
  cwd?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  stderr?: (message: string) => void;
  stdout?: (message: string) => void;
}

type BootstrapFile = {
  path: string;
  value: unknown;
};

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

export function parseCreateProjectArgs(argv: string[]): ProjectBootstrapArgs {
  return parseProjectBootstrapArgs(argv, CREATE_USAGE);
}

export function parseSetupProjectArgs(argv: string[]): ProjectBootstrapArgs {
  return parseProjectBootstrapArgs(argv, SETUP_USAGE);
}

function parseProjectBootstrapArgs(argv: string[], usage: string): ProjectBootstrapArgs {
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
    throw new Error(usage);
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

export async function loadCreateProjectEnv(cwd = process.cwd()): Promise<ProjectBootstrapEnv> {
  const envPath = join(cwd, ".env");

  try {
    const contents = await readFile(envPath, "utf8");
    const values = parseDotEnv(contents);

    return {
      gatewayAuthToken: values.GATEWAY_AUTH_TOKEN?.trim() || undefined,
      memoryUrl: values.VPS_MEMORY_URL?.trim() || undefined,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return {};
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${envPath}: ${detail}`);
  }
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

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function projectFiles(namespace: string, displayName: string): BootstrapFile[] {
  return [
    {
      path: `${namespace}:prd:meta.json`,
      value: {
        description: "TODO",
        name: displayName,
        version: "0.1.0",
      },
    },
    {
      path: `${namespace}:prd:goals.json`,
      value: {
        milestones: [],
        primary: "TODO",
      },
    },
    {
      path: `${namespace}:prd:architecture.json`,
      value: {
        adrs: [],
        components: [],
      },
    },
    {
      path: `${namespace}:prd:constraints.json`,
      value: {
        requirements: [],
      },
    },
    {
      path: `${namespace}:prd:sops.json`,
      value: {
        contacts: {},
        incident_response: "TODO",
      },
    },
  ];
}

async function writeJsonFileIfMissing(path: string, value: unknown): Promise<"created" | "skipped"> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    return "created";
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return "skipped";
    }

    throw error;
  }
}

export function formatManualChecklist(namespace: string, displayName: string): string[] {
  return [
    `[ ] Review generated PRD files for ${displayName}:`,
    `    memory/prd/${namespace}:prd:meta.json`,
    `    memory/prd/${namespace}:prd:goals.json`,
    `    memory/prd/${namespace}:prd:architecture.json`,
    `    memory/prd/${namespace}:prd:constraints.json`,
    `    memory/prd/${namespace}:prd:sops.json`,
    `[ ] Add project docs under memory/${namespace}/`,
    `[ ] Re-run setup after adding new docs to refresh the namespace index`,
    `[ ] Record the first project decision in memory_write(scope="project", namespace="${namespace}", key="init", ...)`,
  ];
}

async function ensureProjectFilesystem(cwd: string, namespace: string, displayName: string): Promise<void> {
  const memoryDir = join(cwd, "memory");
  const projectDir = join(memoryDir, namespace);
  const prdDir = join(memoryDir, "prd");

  await mkdir(projectDir, { recursive: true });
  await mkdir(prdDir, { recursive: true });

  for (const file of projectFiles(namespace, displayName)) {
    await writeJsonFileIfMissing(join(prdDir, file.path), file.value);
  }
}

async function attemptRunnerBootstrap(
  namespace: string,
  displayName: string,
  env: ProjectBootstrapEnv,
  fetchImpl: FetchLike,
  now: () => Date,
  stderr: (message: string) => void,
): Promise<void> {
  const warn = (label: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    stderr(`[warn] ${label}: ${detail}`);
  };

  try {
    await postJson(
      RUNNER_REFRESH_URL,
      { namespace },
      fetchImpl,
      buildRunnerHeaders(env.gatewayAuthToken),
    );
  } catch (error) {
    warn("refresh-namespace failed", error);
  }

  try {
    await postJson(
      `${trimTrailingSlash(env.memoryUrl ?? MEMORY_FALLBACK_URL)}/write`,
      {
        key: "init",
        namespace,
        scope: "project",
        tags: ["init"],
        value: {
          created: now().toISOString(),
          name: displayName,
        },
      },
      fetchImpl,
    );
  } catch (error) {
    warn("memory_write(init) failed", error);
  }
}

async function runProjectBootstrap(
  argv: string[],
  options: ProjectBootstrapOptions,
  usage: string,
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((message: string) => console.log(message));
  const stderr = options.stderr ?? ((message: string) => console.error(message));

  try {
    const args = parseProjectBootstrapArgs(argv, usage);
    const envConfig = await loadCreateProjectEnv(cwd);
    const displayName = args.displayName ?? args.namespace;

    await ensureProjectFilesystem(cwd, args.namespace, displayName);

    if (!args.local) {
      await attemptRunnerBootstrap(args.namespace, displayName, envConfig, fetchImpl, now, stderr);
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

export async function runCreateProject(
  argv: string[],
  options: ProjectBootstrapOptions = {},
): Promise<number> {
  return runProjectBootstrap(argv, options, CREATE_USAGE);
}

export async function runSetupProject(
  argv: string[],
  options: ProjectBootstrapOptions = {},
): Promise<number> {
  return runProjectBootstrap(argv, options, SETUP_USAGE);
}

