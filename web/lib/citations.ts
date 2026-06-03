// #37 — chat-with-seed citations linkable to the timeline (pure).

export interface Citation {
  utterance_id: string
  quote: string
  confidence: number
}
export interface UtteranceRef {
  id: string
  start_ms: number
  end_ms: number
}

export interface TimelineLink extends Citation {
  start_ms: number | null
  end_ms: number | null
}

/** Resolve each citation to a timeline position so a click can seek the player.
 * Citations whose utterance isn't in the set get null positions (still shown). */
export function linkCitations(citations: Citation[], utterances: UtteranceRef[]): TimelineLink[] {
  const byId = new Map(utterances.map((u) => [u.id, u]))
  return citations.map((c) => {
    const u = byId.get(c.utterance_id)
    return {
      ...c,
      start_ms: u?.start_ms ?? null,
      end_ms: u?.end_ms ?? null,
    }
  })
}
