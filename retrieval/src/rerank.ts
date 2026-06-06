import type { ScoredChunk } from './types.js'

/**
 * A cross-encoder scores (query, passage) pairs jointly. The production
 * implementation is bge-reranker-v2-m3 (served via Ollama/a local server);
 * it's injected so the rerank pipeline is testable without the model.
 */
export type CrossEncoder = (query: string, passages: string[]) => Promise<number[]> | number[]

/**
 * Re-rank fused candidates with a cross-encoder and keep the top N
 * (ROADMAP § Retrieval: hybrid → top 50 → rerank → top 5).
 */
export async function rerank(
  query: string,
  candidates: ScoredChunk[],
  crossEncoder: CrossEncoder,
  topN = 5,
): Promise<ScoredChunk[]> {
  if (candidates.length === 0) return []
  const scores = await crossEncoder(
    query,
    candidates.map((c) => c.text),
  )
  if (scores.length !== candidates.length) {
    throw new Error(
      `cross-encoder returned ${scores.length} scores for ${candidates.length} candidates`,
    )
  }
  return (
    candidates
      // biome-ignore lint/style/noNonNullAssertion: scores.length === candidates.length checked above, so index i is in bounds
      .map((c, i) => ({ ...c, score: scores[i]! }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  )
}
