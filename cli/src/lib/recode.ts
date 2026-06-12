import type { EventInput } from '@they-juanreina/compost-provenance'

import { CompostError } from '../errors.js'
import { artifactId, openSeedEvents } from './events.js'

export interface BlindRecodeResult {
  codings: number
  highlights: number
  batch_id: string
}

/**
 * Record a researcher's INDEPENDENT (blind) codings for intercoder agreement.
 *
 * Each (highlight, code) becomes a researcher `link` event on a `coding` artifact,
 * flagged `blind: true`, so `compost agreement` can tell genuine double-coding from
 * reactive endorsement. The "blind" guarantee is procedural — the researcher codes
 * without seeing the machine's codes; this just records the result. Idempotent at
 * the metric level (duplicate (highlight, code) pairs collapse).
 */
export function blindRecode(
  seedPath: string,
  input: {
    assignments: Record<string, string[]>
    researcherId: string
    /** Codebook (frame) these codings are under — agreement is scoped per frame
     * (ADR 0001). Resolved to a CB- id at the command layer (default CB-primary). */
    codebookId: string
  },
): BlindRecodeResult {
  const events = openSeedEvents(seedPath)
  const batchId = `blind-recode:${new Date().toISOString()}`
  try {
    const rows: EventInput[] = []
    for (const [highlight, codes] of Object.entries(input.assignments)) {
      for (const code of new Set(codes)) {
        rows.push({
          artifact_kind: 'coding',
          // codebook is part of the address so the same (highlight, code) coded
          // under two frames is two distinct codings, not a collision.
          artifact_id: artifactId({
            coder: 'researcher-blind',
            highlight,
            code,
            codebook: input.codebookId,
          }),
          action: 'link',
          actor_type: 'researcher',
          actor_id: input.researcherId,
          payload: { code, highlight, blind: true, codebook: input.codebookId },
        })
      }
    }
    if (rows.length === 0) {
      throw new CompostError('INVALID_INPUT', 'No codings to record (assignments were empty).')
    }
    events.appendBatch(rows, batchId)
    return {
      codings: rows.length,
      highlights: Object.keys(input.assignments).length,
      batch_id: batchId,
    }
  } finally {
    events.close()
  }
}
