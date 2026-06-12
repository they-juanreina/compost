import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { EmbeddedItem } from '@they-juanreina/compost-retrieval'

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
