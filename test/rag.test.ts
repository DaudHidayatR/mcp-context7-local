import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, defaultCorpusDirectories, embedText } from "../packages/rag/src/index";

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
});
