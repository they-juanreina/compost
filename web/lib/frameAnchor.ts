// #39 — frame-anchored highlights: auto-link the contemporaneous frame (pure).

export interface FrameRef {
  id: string
  at_ms: number
}

/** Pick the frame nearest a highlight's timestamp within +/- windowMs, or null.
 * Ties go to the earlier frame. */
export function anchorFrame(
  highlightMs: number,
  frames: FrameRef[],
  windowMs = 2000,
): FrameRef | null {
  let best: FrameRef | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const f of frames) {
    const d = Math.abs(f.at_ms - highlightMs)
    if (
      d <= windowMs &&
      (d < bestDist || (d === bestDist && best !== null && f.at_ms < best.at_ms))
    ) {
      best = f
      bestDist = d
    }
  }
  return best
}
