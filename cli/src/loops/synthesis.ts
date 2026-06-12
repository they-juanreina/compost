import {
  clusterByEmbedding,
  type EmbeddedItem,
  meanVector,
  type SaturationPulse,
  saturationPulse,
  suggestCodeClusters,
} from '@they-juanreina/compost-retrieval'

import { DEFAULT_CODEBOOK_ID } from '../lib/artifacts.js'
import { artifactId, emitAgentCreate, openSeedEvents } from '../lib/events.js'

const SCANNER = 'similarity-scanner'
const CATEGORY_SCANNER = 'category-scanner'
const PULSE = 'saturation-pulse'
const VERSION = '0.1.0'
const MAX_SUGGESTIONS = 20

export interface ThemeSuggestion {
  artifact_id: string
  members: string[]
  cohesion: number
}

/**
 * Autonomous theme/code suggestion (#59): cluster un-coded highlights in
 * embedding space and emit one AI-suggested `code` event per cohesive cluster.
 * Throttled to 20 suggestions/run; suggestions are [draft] until endorsed.
 */
export function suggestThemesOnce(
  seedPath: string,
  highlights: EmbeddedItem[],
  opts: { threshold?: number; minSize?: number; model?: string; promptHash?: string } = {},
): ThemeSuggestion[] {
  const clusters = suggestCodeClusters(highlights, {
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.minSize !== undefined ? { minSize: opts.minSize } : {}),
  }).slice(0, MAX_SUGGESTIONS)

  const allIds = highlights.map((h) => h.id)
  const threshold = opts.threshold ?? 0.75
  const events = openSeedEvents(seedPath)
  const out: ThemeSuggestion[] = []
  try {
    for (const cluster of clusters) {
      const initialState = {
        kind: 'code',
        codebook_id: DEFAULT_CODEBOOK_ID,
        members: cluster.members,
        cohesion: cluster.cohesion,
        status: 'draft',
      }
      // Capture the deterministic inputs so this code draft is rerun-able: the
      // clustering is a pure function of the highlight set + params, so recording
      // them lets `compost rerun` re-derive and diff (exactly, if embeddings are
      // unchanged). One bundle per cluster — context carries this cluster's members.
      const event = emitAgentCreate(events, {
        artifactKind: 'code',
        initialState,
        agentName: SCANNER,
        agentVersion: VERSION,
        inputs: {
          model: opts.model ?? `${SCANNER}@${VERSION}`,
          params: {
            threshold,
            ...(opts.minSize !== undefined ? { minSize: opts.minSize } : {}),
          },
          prompt: `cosine-cluster ${allIds.length} highlights; emit cohesive code clusters`,
          context: { highlight_ids: allIds, members: cluster.members },
        },
      })
      out.push({
        artifact_id: event.artifact_id,
        members: cluster.members,
        cohesion: cluster.cohesion,
      })
    }
    return out
  } finally {
    events.close()
  }
}

/** A code positioned in embedding space by the centroid of its evidence. */
export interface CodeForCategorizing {
  id: string
  /** Highlight ids the code is evidenced by. */
  evidence: string[]
  /** The code's frame — categories are codebook-internal (ADR 0002). */
  codebook_id: string
}

export interface CategorySuggestion {
  artifact_id: string
  codebook_id: string
  members: string[]
  cohesion: number
}

/**
 * Autonomous category suggestion (#267): the second-cycle move. Each code is
 * placed in embedding space at the centroid of its evidence-highlight vectors;
 * codes are clustered WITHIN each codebook (categories are frame-internal), and
 * each cohesive cluster of >= minSize codes becomes one AI-suggested `category`
 * draft carrying its member code ids. The proposed grouping lives in the draft's
 * `members[]` (surfaced by `compost category list`), exactly as the highlight
 * scanner's un-named code clusters carry their members — committed
 * code→category links materialize when a researcher endorses and names the
 * draft. Throttled to MAX_SUGGESTIONS per run (global, like suggestThemesOnce).
 * Codes with no embedded evidence are skipped.
 */
export function suggestCategoriesOnce(
  seedPath: string,
  codes: CodeForCategorizing[],
  highlightVectors: Map<string, number[]>,
  opts: { threshold?: number; minSize?: number } = {},
): CategorySuggestion[] {
  const threshold = opts.threshold ?? 0.75
  const minSize = opts.minSize ?? 2

  // Position each code at the centroid of its embedded evidence; group by frame.
  const byCodebook = new Map<string, EmbeddedItem[]>()
  for (const code of codes) {
    const vectors = code.evidence
      .map((h) => highlightVectors.get(h))
      .filter((v): v is number[] => Array.isArray(v) && v.length > 0)
    if (vectors.length === 0) continue // no embedded evidence — can't position it
    const item: EmbeddedItem = { id: code.id, vector: meanVector(vectors) }
    const bucket = byCodebook.get(code.codebook_id)
    if (bucket === undefined) byCodebook.set(code.codebook_id, [item])
    else bucket.push(item)
  }

  // Gather cohesive clusters across every codebook, THEN apply a single global
  // cap — matching suggestThemesOnce, so one run dumps at most MAX_SUGGESTIONS
  // drafts on the researcher regardless of how many frames the seed has.
  const candidates: Array<{ codebook_id: string; members: string[]; cohesion: number }> = []
  for (const [codebook_id, items] of byCodebook) {
    for (const c of clusterByEmbedding(items, threshold).filter(
      (c) => c.members.length >= minSize,
    )) {
      candidates.push({ codebook_id, members: c.members, cohesion: c.cohesion })
    }
  }

  const events = openSeedEvents(seedPath)
  const out: CategorySuggestion[] = []
  try {
    for (const cand of candidates.slice(0, MAX_SUGGESTIONS)) {
      const initialState = {
        kind: 'category',
        codebook_id: cand.codebook_id,
        members: cand.members,
        cohesion: cand.cohesion,
        status: 'draft',
      }
      const event = emitAgentCreate(events, {
        artifactKind: 'category',
        initialState,
        agentName: CATEGORY_SCANNER,
        agentVersion: VERSION,
        inputs: {
          model: `${CATEGORY_SCANNER}@${VERSION}`,
          params: { threshold, minSize },
          prompt: `cluster code centroids within ${cand.codebook_id}; emit cohesive category drafts`,
          context: { codebook_id: cand.codebook_id, members: cand.members },
        },
      })
      out.push({
        artifact_id: event.artifact_id,
        codebook_id: cand.codebook_id,
        members: cand.members,
        cohesion: cand.cohesion,
      })
    }
    return out
  } finally {
    events.close()
  }
}

export interface PulseResult extends SaturationPulse {
  notify: boolean
  artifact_id: string
}

/**
 * Saturation-pulse loop (#61): compute the pulse and emit an AI suggestion
 * recording it. `notify` is true when the recommendation is pause/conclude —
 * the watcher surfaces that to the researcher.
 */
export function saturationPulseOnce(
  seedPath: string,
  sessions: Array<{ id: string; themes: string[] }>,
): PulseResult {
  const pulse = saturationPulse(sessions)
  const events = openSeedEvents(seedPath)
  try {
    const initialState = { kind: 'saturation_pulse', ...pulse }
    const event = emitAgentCreate(events, {
      artifactKind: 'insight',
      initialState,
      agentName: PULSE,
      agentVersion: VERSION,
    })
    return {
      ...pulse,
      notify: pulse.recommendation !== 'continue',
      artifact_id: event.artifact_id ?? artifactId(initialState),
    }
  } finally {
    events.close()
  }
}
