import type { ScoredChunk } from './types.js'

export interface DedupeOptions {
  /** Two same-session chunks conflict when their time ranges overlap by at least
   * this fraction of the shorter chunk's span. 0.5 collapses the chunker's
   * solo-utterance vs neighbor-window duplicates (and adjacent overlapping
   * windows) while leaving merely-abutting distinct utterances alone. */
  overlapThreshold?: number
}

function span(c: ScoredChunk): { s: number; e: number } | null {
  const s = c.metadata.start_ms
  const e = c.metadata.end_ms
  if (s === null || e === null || e <= s) return null
  return { s, e }
}

/**
 * Result-level de-duplication by region (#170). The chunker emits a solo
 * `utterance` chunk *and* a 5-utterance `window` per utterance, so adjacent
 * windows overlap 4/5 and the same phrase surfaces several times in top-k. Given
 * a rank-ordered list, keep the highest-ranked chunk for each region and drop any
 * later chunk that overlaps an already-kept one (same session) past the
 * threshold. Non-temporal chunks (page/term/highlight with no ms range) are never
 * dropped. Stable: input order is preserved among kept chunks.
 */
export function dedupeByRegion(chunks: ScoredChunk[], opts: DedupeOptions = {}): ScoredChunk[] {
  const threshold = opts.overlapThreshold ?? 0.5
  const kept: ScoredChunk[] = []
  const keptSpans: Array<{ session: string; s: number; e: number }> = []

  for (const c of chunks) {
    const sp = span(c)
    if (sp === null) {
      kept.push(c)
      continue
    }
    const session = c.metadata.session
    const conflict = keptSpans.some((k) => {
      if (k.session !== session) return false
      const overlap = Math.min(sp.e, k.e) - Math.max(sp.s, k.s)
      if (overlap <= 0) return false
      const minSpan = Math.min(sp.e - sp.s, k.e - k.s)
      return minSpan > 0 && overlap / minSpan >= threshold
    })
    if (!conflict) {
      kept.push(c)
      keptSpans.push({ session, s: sp.s, e: sp.e })
    }
  }
  return kept
}
