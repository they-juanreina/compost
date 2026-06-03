// #34 — highlight creation (mouse + keyboard): span math (pure).

export interface HighlightDraft {
  utterance_id: string
  span: [number, number]
  text: string
}

/** Build a highlight from a text selection within an utterance. Clamps to the
 * utterance bounds and normalizes reversed selections. Returns null for an
 * empty selection. */
export function highlightFromSelection(
  utterance: { id: string; text: string },
  selStart: number,
  selEnd: number,
): HighlightDraft | null {
  const len = utterance.text.length
  let a = Math.max(0, Math.min(selStart, len))
  let b = Math.max(0, Math.min(selEnd, len))
  if (a > b) [a, b] = [b, a]
  if (a === b) return null
  return { utterance_id: utterance.id, span: [a, b], text: utterance.text.slice(a, b) }
}

/** Keyboard word-extend: grow the selection end to the next word boundary. */
export function extendToWord(text: string, end: number): number {
  let i = end
  while (i < text.length && /\s/.test(text[i] as string)) i++
  while (i < text.length && !/\s/.test(text[i] as string)) i++
  return i
}
