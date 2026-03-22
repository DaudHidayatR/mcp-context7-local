import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromaRagService, chunkText, defaultCorpusDirectories, embedText } from "../packages/rag/src/index";

interface FakeRecord {
  document: string;
  embedding: number[];
  id: string;
  metadata: Record<string, string | number | boolean>;
}

class FakeCollection {
  readonly name: string;
  private readonly records = new Map<string, FakeRecord>();

  constructor(name: string) {
    this.name = name;
  }

  async upsert(args: {
    documents: string[];
    embeddings: number[][];
    ids: string[];
    metadatas: Array<Record<string, string | number | boolean>>;
  }): Promise<void> {
    for (let index = 0; index < args.ids.length; index += 1) {
      this.records.set(args.ids[index], {
        document: args.documents[index],
        embedding: args.embeddings[index],
        id: args.ids[index],
        metadata: args.metadatas[index],
      });
    }
  }

  async query(args: { nResults?: number; queryEmbeddings?: number[][] }) {
    const queryEmbedding = args.queryEmbeddings?.[0] ?? [];
    const matches = [...this.records.values()]
      .map((record) => ({
        ...record,
        distance: 1 - dotProduct(queryEmbedding, record.embedding),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, args.nResults ?? 10);

    return {
      distances: [matches.map((match) => match.distance)],
      documents: [matches.map((match) => match.document)],
      ids: [matches.map((match) => match.id)],
      metadatas: [matches.map((match) => match.metadata)],
    };
  }
}

class FakeChromaClient {
  private readonly collections = new Map<string, FakeCollection>();

  async countCollections(): Promise<number> {
    return this.collections.size;
  }

  async deleteCollection({ name }: { name: string }): Promise<void> {
    if (!this.collections.delete(name)) {
      throw new Error(`Collection ${name} does not exist`);
    }
  }

  async getOrCreateCollection({ name }: { name: string }): Promise<FakeCollection> {
    let collection = this.collections.get(name);
    if (!collection) {
      collection = new FakeCollection(name);
      this.collections.set(name, collection);
    }
    return collection;
  }

  async listCollections({ limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<FakeCollection[]> {
    return [...this.collections.values()].slice(offset, offset + limit);
  }
}

function dotProduct(left: number[], right: number[]): number {
  let total = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

function createTestRagService(): ChromaRagService {
  const service = new ChromaRagService({
    collectionName: "default-collection",
    url: "http://127.0.0.1:8000",
  });
  (service as unknown as { client: FakeChromaClient }).client = new FakeChromaClient();
  return service;
}

describe("rag utilities", () => {
  test("embeddings are deterministic and normalized", () => {
    const first = embedText("React router docs");
    const second = embedText("React router docs");

    expect(first).toEqual(second);
    expect(first.length).toBe(64);
  });

  test("chunkText splits large text into multiple chunks", () => {
    const text = "a".repeat(2000);
    const chunks = chunkText(text, { chunkOverlap: 100, chunkSize: 500 });

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].length).toBeLessThanOrEqual(500);
  });

  test("default corpus directories point at mounted platform folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "context7-platform-"));
    await Promise.all([
      mkdir(join(root, "docs")),
      mkdir(join(root, "memory")),
      mkdir(join(root, "schemas")),
      mkdir(join(root, "skills")),
    ]);
    await writeFile(join(root, "docs", "intro.md"), "# Intro");

    expect(defaultCorpusDirectories(root)).toEqual([
      join(root, "docs"),
      join(root, "skills"),
      join(root, "schemas"),
      join(root, "memory"),
    ]);
  });

  test("syncs and queries isolated namespaces in separate collections", async () => {
    const root = await mkdtemp(join(tmpdir(), "context7-rag-namespace-"));
    const alphaDir = join(root, "alpha");
    const betaDir = join(root, "beta");

    await Promise.all([mkdir(alphaDir), mkdir(betaDir)]);
    await Promise.all([
      writeFile(join(alphaDir, "alpha.md"), "alpha-orbit-token lives only in the alpha project"),
      writeFile(join(betaDir, "beta.md"), "beta-lattice-token lives only in the beta project"),
    ]);

    const rag = createTestRagService();

    await rag.syncDirectories([alphaDir], "Project Alpha");
    await rag.syncDirectories([betaDir], "Project/Beta");

    const alphaHits = await rag.query("alpha-orbit-token", 10, "Project Alpha");
    const betaHits = await rag.query("beta-lattice-token", 10, "Project/Beta");
    const collections = await rag.listCollections();

    expect(alphaHits).toHaveLength(1);
    expect(alphaHits[0]?.metadata.path).toBe("alpha.md");
    expect(alphaHits[0]?.id).toContain(`${alphaDir}:alpha.md#0`);

    expect(betaHits).toHaveLength(1);
    expect(betaHits[0]?.metadata.path).toBe("beta.md");
    expect(betaHits[0]?.id).toContain(`${betaDir}:beta.md#0`);

    expect(collections).toEqual(expect.arrayContaining(["project-alpha", "project-beta"]));
  });
});
