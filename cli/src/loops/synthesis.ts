import {
  type EmbeddedItem,
  type SaturationPulse,
  saturationPulse,
  suggestCodeClusters,
} from '@they-juanreina/compost-retrieval'

import { DEFAULT_CODEBOOK_ID } from '../lib/artifacts.js'
import { artifactId, emitAgentCreate, openSeedEvents } from '../lib/events.js'

const SCANNER = 'similarity-scanner'
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
