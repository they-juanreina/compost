import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { emitAgentCreate, openSeedEvents } from './events.js'

// `compost tag` / `compost code` (#49): suggest (default) or --apply glossary
// terms and codes. Term suggestion is a deterministic recurring-noun-phrase
// extractor; code suggestion reuses the similarity scanner. Suggestions are
// AI/agent [draft] events until applied/endorsed.

const AGENT = 'tagger'
const VERSION = '0.1.0'

export interface TermSuggestion {
  term_id: string
  phrase: string
  count: number
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'una',
  'unos',
  'unas',
  'los',
  'las',
  'del',
  'por',
  'con',
  'que',
  'para',
  'como',
  'pero',
  'más',
  'muy',
  'sin',
  'sus',
  'les',
  'una',
])

/** Extract candidate glossary terms: multiword phrases (2-3 tokens) that recur
 * >= minCount times across utterances, excluding stopword-only phrases. */
export function suggestTerms(
  utterances: Array<{ text: string }>,
  opts: { minCount?: number } = {},
): TermSuggestion[] {
  const minCount = opts.minCount ?? 2
  const counts = new Map<string, number>()
  for (const u of utterances) {
    const tokens = u.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n)
        if (gram.every((t) => STOPWORDS.has(t))) continue
        const phrase = gram.join(' ')
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phrase, count]) => ({ term_id: `T-${phrase.replace(/\s+/g, '-')}`, phrase, count }))
}

export interface TagResult {
  suggested: TermSuggestion[]
  applied: boolean
}

/** Suggest terms; with apply=true, write them to glossary/glossary.md and emit
 * agent create events. */
export function tagSeed(
  seedPath: string,
  utterances: Array<{ text: string }>,
  opts: { apply?: boolean; minCount?: number } = {},
): TagResult {
  const suggested = suggestTerms(
    utterances,
    opts.minCount !== undefined ? { minCount: opts.minCount } : {},
  )
  if (opts.apply !== true) return { suggested, applied: false }

  const glossaryDir = join(seedPath, 'glossary')
  mkdirSync(glossaryDir, { recursive: true })
  const glossary = join(glossaryDir, 'glossary.md')
  if (!existsSync(glossary)) writeFileSync(glossary, '# Glossary\n\n', 'utf8')
  const events = openSeedEvents(seedPath)
  try {
    for (const t of suggested) {
      appendFileSync(
        glossary,
        `- **${t.phrase}** (\`${t.term_id}\`) — _${t.count} mentions; define me_\n`,
        'utf8',
      )
      emitAgentCreate(events, {
        artifactKind: 'term',
        initialState: { term_id: t.term_id, phrase: t.phrase, count: t.count, status: 'draft' },
        agentName: AGENT,
        agentVersion: VERSION,
      })
    }
  } finally {
    events.close()
  }
  return { suggested, applied: true }
}
