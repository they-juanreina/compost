// #33 — synchronized transcript/video player: timeline math (pure).

export interface Cue {
  id: string
  kind: string
  start_ms: number
  end_ms: number
}
export interface Frame {
  id: string
  at_ms: number
  path: string
}
export interface Utterance {
  id: string
  start_ms: number
  end_ms: number
}

/** Cues active at the playhead (start <= t < end). */
export function activeCues(currentMs: number, cues: Cue[]): Cue[] {
  return cues.filter((c) => currentMs >= c.start_ms && currentMs < c.end_ms)
}

/** The utterance under the playhead, or null. */
export function activeUtterance(currentMs: number, utterances: Utterance[]): Utterance | null {
  return utterances.find((u) => currentMs >= u.start_ms && currentMs < u.end_ms) ?? null
}

/** Frame strip: frames sorted by time, with the one nearest (and at/just
 * before) the playhead marked active for the scrubber. */
export function frameStrip(currentMs: number, frames: Frame[]): Array<Frame & { active: boolean }> {
  const sorted = [...frames].sort((a, b) => a.at_ms - b.at_ms)
  let activeId: string | null = null
  for (const f of sorted) {
    if (f.at_ms <= currentMs) activeId = f.id
  }
  return sorted.map((f) => ({ ...f, active: f.id === activeId }))
}
