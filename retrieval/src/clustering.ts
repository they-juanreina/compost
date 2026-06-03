import { cosineSimilarity } from './embeddings.js'

// Embeddings-aware helpers backing the refactored research-os skills:
//   - thematic-coding (#52): cluster un-coded highlights → candidate codes
//   - saturation-analysis (#53): per-session theme novelty → recommendation

export interface EmbeddedItem {
  id: string
  vector: number[]
}

export interface Cluster {
  members: string[]
  /** Mean pairwise cosine similarity within the cluster (cohesion). */
  cohesion: number
}

/**
 * Greedy single-link clustering by cosine similarity. Deterministic: items are
 * processed in input order, each joins the first existing cluster whose
 * centroid it's within `threshold` of, else seeds a new cluster.
 */
export function clusterByEmbedding(items: EmbeddedItem[], threshold = 0.75): Cluster[] {
  const clusters: Array<{ members: EmbeddedItem[] }> = []
  for (const item of items) {
    let placed = false
    for (const cluster of clusters) {
      const centroid = meanVector(cluster.members.map((m) => m.vector))
      if (cosineSimilarity(item.vector, centroid) >= threshold) {
        cluster.members.push(item)
        placed = true
        break
      }
    }
    if (!placed) clusters.push({ members: [item] })
  }
  return clusters.map((c) => ({
    members: c.members.map((m) => m.id),
    cohesion: Number(meanPairwiseCohesion(c.members.map((m) => m.vector)).toFixed(4)),
  }))
}

/** Candidate codes = clusters of >= minSize un-coded highlights. */
export function suggestCodeClusters(
  highlights: EmbeddedItem[],
  opts: { threshold?: number; minSize?: number } = {},
): Cluster[] {
  const minSize = opts.minSize ?? 2
  return clusterByEmbedding(highlights, opts.threshold ?? 0.75).filter(
    (c) => c.members.length >= minSize,
  )
}

export interface SaturationPulse {
  per_session: Array<{ session: string; new_themes: string[]; novelty: number }>
  recommendation: 'continue' | 'pause' | 'conclude'
  rationale: string
}

/**
 * Saturation by theme novelty across sessions (order matters). Each session's
 * novelty = fraction of its themes not seen in any earlier session. Recommends
 * pause/conclude when the tail is dry.
 */
export function saturationPulse(
  sessions: Array<{ id: string; themes: string[] }>,
  opts: { dryStreakToConclude?: number } = {},
): SaturationPulse {
  const dryToConclude = opts.dryStreakToConclude ?? 2
  const seen = new Set<string>()
  const per: SaturationPulse['per_session'] = []
  let dryStreak = 0
  for (const s of sessions) {
    const fresh = s.themes.filter((t) => !seen.has(t))
    for (const t of s.themes) seen.add(t)
    const novelty = s.themes.length === 0 ? 0 : fresh.length / s.themes.length
    per.push({ session: s.id, new_themes: fresh, novelty: Number(novelty.toFixed(3)) })
    if (fresh.length === 0) dryStreak += 1
    else dryStreak = 0
  }

  let recommendation: SaturationPulse['recommendation'] = 'continue'
  let rationale = 'New themes are still emerging; keep collecting.'
  if (dryStreak >= dryToConclude) {
    recommendation = 'conclude'
    rationale = `No new themes for ${dryStreak} consecutive sessions; saturation reached.`
  } else if (dryStreak === 1) {
    recommendation = 'pause'
    rationale = 'The last session added no new themes; pause and review before continuing.'
  }
  return { per_session: per, recommendation, rationale }
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0]!.length
  const out = new Array(dim).fill(0)
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]!
  return out.map((x) => x / vectors.length)
}

function meanPairwiseCohesion(vectors: number[][]): number {
  if (vectors.length < 2) return 1
  let sum = 0
  let n = 0
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosineSimilarity(vectors[i]!, vectors[j]!)
      n += 1
    }
  }
  return n === 0 ? 1 : sum / n
}
