import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { ChromaClient, type EmbeddingFunction } from "chromadb";

const DEFAULT_DIMENSIONS = 64;
const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 120;
const TEXT_FILE_EXTENSIONS = new Set([
  "",
  ".json",
  ".md",
  ".markdown",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".yaml",
  ".yml",
]);

export interface RagDocument {
  content: string;
  id: string;
  metadata: Record<string, string | number | boolean>;
}

export interface RagHit {
  content: string;
  distance: number | null;
  id: string;
  metadata: Record<string, unknown>;
}

export interface RagSyncResult {
  collection: string;
  documents: number;
  indexedAt: string;
}

export interface ChromaRagConfig {
  chunkOverlap?: number;
  chunkSize?: number;
  collectionName: string;
  dimensions?: number;
  url: string;
}

function createEmbeddingFunction(dimensions: number): EmbeddingFunction {
  return {
    generate: async (texts: string[]) => texts.map((text) => embedText(text, dimensions)),
    name: "context7-local-embed",
  };
}

function hashToken(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function embedText(text: string, dimensions = DEFAULT_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9_/-]+/g) ?? [];

  for (const token of tokens) {
    const hash = hashToken(token);
    const slot = hash % dimensions;
    const weight = 1 + (token.length % 7);
    vector[slot] += weight;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

export function chunkText(
  text: string,
  options: { chunkOverlap?: number; chunkSize?: number } = {},
): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const chunks: string[] = [];

  if (!text.trim()) return chunks;

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - chunkOverlap, start + 1);
  }

  return chunks;
}

function normalizeCollectionName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

type ChromaCollection = Awaited<ReturnType<ChromaClient["getOrCreateCollection"]>>;

async function collectTextFiles(dir: string, rootDir = dir): Promise<RagDocument[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const docs: RagDocument[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      docs.push(...await collectTextFiles(fullPath, rootDir));
      continue;
    }

    const extension = extname(entry.name);
    if (!TEXT_FILE_EXTENSIONS.has(extension)) continue;

    try {
      const content = await readFile(fullPath, "utf8");
      docs.push({
        content,
        id: relative(rootDir, fullPath),
        metadata: {
          path: relative(rootDir, fullPath),
          sourceDir: rootDir,
        },
      });
    } catch {
      // ignore binary or unreadable files
    }
  }

  return docs;
}

export class ChromaRagService {
  private readonly chunkOverlap: number;
  private readonly chunkSize: number;
  private readonly collections = new Map<string, Promise<ChromaCollection>>();
  private readonly collectionName: string;
  private readonly dimensions: number;
  private readonly client: ChromaClient;
  private readonly embeddingFunction: EmbeddingFunction;
  private readonly url: string;

  constructor(config: ChromaRagConfig) {
    const url = new URL(config.url);
    this.client = new ChromaClient({
      host: url.hostname,
      port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
      ssl: url.protocol === "https:",
    });
    this.collectionName = normalizeCollectionName(config.collectionName);
    this.chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    this.chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
    this.embeddingFunction = createEmbeddingFunction(this.dimensions);
    this.url = url.toString().replace(/\/$/, "");
  }

  async health(): Promise<{ collection: string; ok: boolean; url: string }> {
    await this.ensureCollection();
    return {
      collection: this.collectionName,
      ok: true,
      url: this.url,
    };
  }

  async syncDirectories(directories: string[], namespace?: string): Promise<RagSyncResult> {
    const docs = (
      await Promise.all(directories.map((directory) => this.collectDocuments(directory)))
    ).flat();
    const collectionName = this.resolveCollectionName(namespace);

    await this.resetCollection(collectionName);
    if (docs.length > 0) {
      const collection = await this.ensureCollection(collectionName);
      const embeddings = docs.map((doc) => embedText(doc.content, this.dimensions));

      for (let index = 0; index < docs.length; index += 100) {
        const batch = docs.slice(index, index + 100);
        await collection.upsert({
          documents: batch.map((doc) => doc.content),
          embeddings: embeddings.slice(index, index + 100),
          ids: batch.map((doc) => doc.id),
          metadatas: batch.map((doc) => doc.metadata),
        });
      }
    }

    return {
      collection: collectionName,
      documents: docs.length,
      indexedAt: new Date().toISOString(),
    };
  }

  async query(query: string, topK: number, namespace?: string): Promise<RagHit[]> {
    const collection = await this.ensureCollection(this.resolveCollectionName(namespace));
    const response = await collection.query({
      include: ["documents", "metadatas", "distances"],
      nResults: topK,
      queryEmbeddings: [embedText(query, this.dimensions)],
    });

    const ids = response.ids?.[0] ?? [];
    const documents = response.documents?.[0] ?? [];
    const metadatas = response.metadatas?.[0] ?? [];
    const distances = response.distances?.[0] ?? [];

    return ids.map((id, index) => ({
      content: documents[index] ?? "",
      distance: distances[index] ?? null,
      id,
      metadata: (metadatas[index] as Record<string, unknown>) ?? {},
    }));
  }

  async listCollections(): Promise<string[]> {
    const total = await this.client.countCollections();
    if (total === 0) return [];

    const collections: ChromaCollection[] = [];
    for (let offset = 0; offset < total; offset += 100) {
      collections.push(...await this.client.listCollections({ limit: 100, offset }));
    }

    return collections.map((collection) => collection.name);
  }

  private resolveCollectionName(namespace?: string): string {
    return namespace ? normalizeCollectionName(namespace) : this.collectionName;
  }

  private async ensureCollection(collectionName = this.collectionName): Promise<ChromaCollection> {
    const existing = this.collections.get(collectionName);
    if (existing) return existing;

    const collectionPromise = this.client.getOrCreateCollection({
      embeddingFunction: this.embeddingFunction,
      name: collectionName,
    }).catch((error) => {
      this.collections.delete(collectionName);
      throw error;
    });

    this.collections.set(collectionName, collectionPromise);
    return collectionPromise;
  }

  private async resetCollection(collectionName = this.collectionName): Promise<void> {
    try {
      await this.client.deleteCollection({ name: collectionName });
    } catch {
      // collection may not exist yet
    }
    this.collections.delete(collectionName);
    await this.ensureCollection(collectionName);
  }

  private async collectDocuments(directory: string): Promise<RagDocument[]> {
    const rawDocs = await collectTextFiles(directory, directory);

    return rawDocs.flatMap((doc) => {
      const chunks = chunkText(doc.content, {
        chunkOverlap: this.chunkOverlap,
        chunkSize: this.chunkSize,
      });

      return chunks.map((chunk, index) => ({
        content: chunk,
        id: `${String(doc.metadata.sourceDir)}:${String(doc.metadata.path)}#${index}`,
        metadata: {
          ...doc.metadata,
          chunk: index,
        },
      }));
    });
  }
}

export function defaultCorpusDirectories(root = "/app"): string[] {
  return [
    join(root, "docs"),
    join(root, "skills"),
    join(root, "schemas"),
    join(root, "memory"),
  ];
}

export function defaultRagConfig(env: Record<string, string | undefined>): ChromaRagConfig {
  return {
    collectionName: env.RAG_COLLECTION ?? "context7-local",
    url: env.CHROMA_URL ?? "http://127.0.0.1:8000",
  };
}
