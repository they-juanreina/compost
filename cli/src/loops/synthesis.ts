import {
  type EmbeddedItem,
  type SaturationPulse,
  saturationPulse,
  suggestCodeClusters,
} from 'compost-retrieval'

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

  const events = openSeedEvents(seedPath)
  const out: ThemeSuggestion[] = []
  try {
    for (const cluster of clusters) {
      const initialState = {
        kind: 'code',
        members: cluster.members,
        cohesion: cluster.cohesion,
        status: 'draft',
      }
      const event = emitAgentCreate(events, {
        artifactKind: 'code',
        initialState,
        agentName: SCANNER,
        agentVersion: VERSION,
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
