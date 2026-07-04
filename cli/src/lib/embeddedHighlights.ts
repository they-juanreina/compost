import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type EmbeddedItem, isDegenerateVector } from '@they-juanreina/compost-retrieval'

import { CompostError } from '../errors.js'

/**
 * Load embedded highlights from `highlights/*.json` ({id, vector} sidecars
 * written by the highlight-embed worker, #262) — the surface the
 * cross-session-similarity scanner reads. Empty when none are embedded yet.
 * Shared by `compost rescan` and `compost category suggest`.
 */
export function loadEmbeddedHighlights(seedPath: string): EmbeddedItem[] {
  const dir = join(seedPath, 'highlights')
  if (!existsSync(dir)) return []
  const out: EmbeddedItem[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = join(dir, f)
    if (!statSync(p).isFile()) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { id?: string; vector?: number[] }
      if (typeof j.id === 'string' && Array.isArray(j.vector)) {
        out.push({ id: j.id, vector: j.vector })
      }
    } catch {
      // skip malformed sidecars
    }
  }
  return out
}

/** Highlight id → embedding vector, for building code centroids (#267). */
export function loadHighlightVectorMap(seedPath: string): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const h of loadEmbeddedHighlights(seedPath)) map.set(h.id, h.vector)
  return map
}

/** Count highlight artifacts (`highlights/H-*.md`) — the highlights the
 * researcher created, which should each have an embedding sidecar. */
export function countHighlightArtifacts(seedPath: string): number {
  const dir = join(seedPath, 'highlights')
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir)) if (f.endsWith('.md')) n += 1
  return n
}

/**
 * Precondition for the clustering surfaces (`rescan`, `code`): the highlights a
 * researcher created must be embedded with usable vectors. Without this guard a
 * failed embedding pass silently degrades — zero clusters surfaced, or one bogus
 * cluster swallowing every highlight — which reads as "the tool found nothing"
 * instead of "the embeddings never ran" (dogfood 2026-07-01). Throws a
 * `CompostError` naming the fix. A no-op when there are simply no highlights yet
 * (nothing to cluster is not an error).
 */
export function assertHighlightsEmbedded(seedPath: string, embedded: EmbeddedItem[]): void {
  const total = countHighlightArtifacts(seedPath)
  if (total === 0) return
  if (embedded.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      `${total} highlight(s) exist but none are embedded, so clustering has nothing to compare. Run \`compost reindex --vectors\` to embed them, then retry.`,
    )
  }
  if (embedded.every((h) => isDegenerateVector(h.vector))) {
    throw new CompostError(
      'INVALID_INPUT',
      `All ${embedded.length} highlight embedding(s) are degenerate (empty/zero/NaN vectors) — the embedding provider likely failed. Check it with \`compost doctor\`, then re-run \`compost reindex --vectors\`.`,
    )
  }
}
