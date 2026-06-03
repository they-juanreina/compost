// #38 — glossary inline suggestions + CRUD (pure).

export interface Term {
  term_id: string
  phrase: string
  definition?: string
}
export interface TermSpan {
  term_id: string
  span: [number, number]
}

/** Find case-insensitive occurrences of glossary phrases in an utterance,
 * longest-phrase-first so "data hub" wins over "data". Non-overlapping. */
export function inlineTermSpans(text: string, terms: Term[]): TermSpan[] {
  const lower = text.toLowerCase()
  const ordered = [...terms].sort((a, b) => b.phrase.length - a.phrase.length)
  const taken: boolean[] = new Array(text.length).fill(false)
  const out: TermSpan[] = []
  for (const t of ordered) {
    const needle = t.phrase.toLowerCase()
    let from = 0
    while (true) {
      const idx = lower.indexOf(needle, from)
      if (idx === -1) break
      const end = idx + needle.length
      let free = true
      for (let i = idx; i < end; i++) if (taken[i]) free = false
      if (free) {
        for (let i = idx; i < end; i++) taken[i] = true
        out.push({ term_id: t.term_id, span: [idx, end] })
      }
      from = idx + needle.length
    }
  }
  return out.sort((a, b) => a.span[0] - b.span[0])
}

export function upsertTerm(terms: Term[], term: Term): Term[] {
  const i = terms.findIndex((t) => t.term_id === term.term_id)
  if (i === -1) return [...terms, term]
  const copy = [...terms]
  copy[i] = term
  return copy
}

export function deleteTerm(terms: Term[], termId: string): Term[] {
  return terms.filter((t) => t.term_id !== termId)
}
