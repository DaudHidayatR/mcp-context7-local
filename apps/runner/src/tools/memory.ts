import { z } from "zod";

const memoryReadArgsSchema = z.object({
  scope: z.string(),
  namespace: z.string(),
  key: z.string(),
});

const memoryReadAllArgsSchema = z.object({
  scope: z.string(),
  namespace: z.string(),
});

const memoryWriteArgsSchema = z.object({
  scope: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.unknown(),
  tags: z.array(z.string()).default([]),
  ttl_seconds: z.number().int().positive().nullable().default(null),
});

export interface MemoryEntry {
  value: unknown;
  version: number;
  expiresAt: number | null;
  tags: string[];
  writtenAt: number;
}

export class InMemoryStore {
  private data = new Map<string, MemoryEntry>();

  private key(scope: string, namespace: string, key: string): string {
    return `${scope}::${namespace}::${key}`;
  }

  read(scope: string, namespace: string, key: string): {
    value: unknown;
    found: boolean;
    age_seconds: number;
    version: number;
  } {
    const entry = this.data.get(this.key(scope, namespace, key));
    if (!entry) {
      return { value: null, found: false, age_seconds: 0, version: 0 };
    }

    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.data.delete(this.key(scope, namespace, key));
      return { value: null, found: false, age_seconds: 0, version: 0 };
    }

    return {
      value: entry.value,
      found: true,
      age_seconds: Math.floor((Date.now() - entry.writtenAt) / 1000),
      version: entry.version,
    };
  }

  readAll(scope: string, namespace: string): {
    entries: Array<{ key: string; value: unknown; age_seconds: number; version: number }>;
  } {
    const prefix = `${scope}::${namespace}::`;
    const entries: Array<{ key: string; value: unknown; age_seconds: number; version: number }> = [];

    for (const [fullKey, entry] of this.data) {
      if (!fullKey.startsWith(prefix)) continue;
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        this.data.delete(fullKey);
        continue;
      }

      entries.push({
        key: fullKey.slice(prefix.length),
        value: entry.value,
        age_seconds: Math.floor((Date.now() - entry.writtenAt) / 1000),
        version: entry.version,
      });
    }

    return { entries };
  }

  write(
    scope: string,
    namespace: string,
    key: string,
    value: unknown,
    tags: string[],
    ttlSeconds: number | null,
  ): { ok: boolean; version_id: number } {
    const storageKey = this.key(scope, namespace, key);
    const existing = this.data.get(storageKey);
    const version = existing ? existing.version + 1 : 1;

    this.data.set(storageKey, {
      value,
      version,
      expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
      tags,
      writtenAt: Date.now(),
    });

    return { ok: true, version_id: version };
  }
}

export interface MemoryProxy {
  memoryUrl?: string;
  proxyToMemory(url: string, body: unknown): Promise<unknown>;
  store: InMemoryStore;
}

export async function handleMemoryRead(
  args: unknown,
  deps: MemoryProxy,
): Promise<unknown> {
  const { scope, namespace, key } = memoryReadArgsSchema.parse(args ?? {});
  if (deps.memoryUrl) {
    return deps.proxyToMemory(`${deps.memoryUrl}/read`, { scope, namespace, key });
  }
  return deps.store.read(scope, namespace, key);
}

export async function handleMemoryReadAll(
  args: unknown,
  deps: MemoryProxy,
): Promise<unknown> {
  const { scope, namespace } = memoryReadAllArgsSchema.parse(args ?? {});
  if (deps.memoryUrl) {
    return deps.proxyToMemory(`${deps.memoryUrl}/read-all`, { scope, namespace });
  }
  return deps.store.readAll(scope, namespace);
}

export async function handleMemoryWrite(
  args: unknown,
  deps: MemoryProxy,
): Promise<unknown> {
  const { scope, namespace, key, value, tags, ttl_seconds } = memoryWriteArgsSchema.parse(args ?? {});
  if (deps.memoryUrl) {
    return deps.proxyToMemory(`${deps.memoryUrl}/write`, {
      key,
      namespace,
      scope,
      tags,
      ttl_seconds,
      value,
    });
  }
  return deps.store.write(scope, namespace, key, value, tags, ttl_seconds);
}
