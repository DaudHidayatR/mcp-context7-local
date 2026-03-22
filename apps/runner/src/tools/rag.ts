import type { RagHit } from "@platform/rag";
import { z } from "zod";

const ragSearchArgsSchema = z.object({
  namespace: z.string(),
  query: z.string(),
  top_k: z.number().int().positive().default(5),
});

export interface RagSearchDependencies {
  query(query: string, topK: number, namespace?: string): Promise<RagHit[]>;
}

export async function handleRagSearch(
  args: unknown,
  rag: RagSearchDependencies,
): Promise<{ results: RagHit[] }> {
  const { namespace, query, top_k } = ragSearchArgsSchema.parse(args ?? {});
  const hits = await rag.query(query, top_k, namespace);
  return { results: hits };
}
