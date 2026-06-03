import type { Chunk, ScoredChunk } from './types.js'

export const RRF_K = 60

/** Reciprocal Rank Fusion: merge ranked lists by sum of 1/(k + rank). */
export function reciprocalRankFusion(
  lists: ScoredChunk[][],
  k: number = RRF_K,
  limit = 50,
): ScoredChunk[] {
  const byId = new Map<string, { chunk: Chunk; score: number }>()
  for (const list of lists) {
    list.forEach((chunk, idx) => {
      const rank = idx + 1
      const contribution = 1 / (k + rank)
      const existing = byId.get(chunk.id)
      if (existing) existing.score += contribution
      else byId.set(chunk.id, { chunk, score: contribution })
    })
  }
  return [...byId.values()]
    .map(({ chunk, score }) => ({ ...chunk, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
