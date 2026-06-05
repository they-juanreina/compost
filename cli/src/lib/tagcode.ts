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

// Function words, modals, pronouns, common conversational fillers (EN + ES) —
// any phrase touching one of these is dropped. Scoped to grammatical glue and
// filler; content nouns/verbs/adjectives don't appear here, so legitimate noun
// phrases ("manual override", "alerta automática") survive (#171). The pre-fix
// list was 24 tokens and only dropped *all-stopword* phrases, so "you know"
// (64), "and like" (40), "right like" (38) leaked into glossary suggestions.
const STOPWORDS = new Set([
  // EN — fillers, modals, pronouns, common helpers
  'the',
  'and',
  'but',
  'for',
  'with',
  'that',
  'this',
  'these',
  'those',
  'you',
  'your',
  'yours',
  'his',
  'her',
  'hers',
  'its',
  'our',
  'ours',
  'they',
  'their',
  'them',
  'theirs',
  'mine',
  'ours',
  'are',
  'was',
  'were',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  'must',
  'into',
  'onto',
  'about',
  'from',
  'over',
  'under',
  'after',
  'before',
  'like',
  'just',
  'kind',
  'sort',
  'know',
  'mean',
  'think',
  'say',
  'said',
  'got',
  'get',
  'going',
  'gone',
  'want',
  'need',
  'see',
  'look',
  'take',
  'make',
  'made',
  'come',
  'came',
  'well',
  'okay',
  'right',
  'yeah',
  'really',
  'actually',
  'maybe',
  // ES — equivalents
  'una',
  'unos',
  'unas',
  'los',
  'las',
  'del',
  'por',
  'con',
  'sin',
  'que',
  'qué',
  'para',
  'pero',
  'sino',
  'como',
  'más',
  'muy',
  'sus',
  'les',
  'nos',
  'mis',
  'tus',
  'este',
  'esta',
  'estos',
  'estas',
  'eso',
  'esa',
  'esos',
  'esas',
  'ese',
  'todo',
  'todos',
  'toda',
  'todas',
  'ser',
  'estar',
  'son',
  'soy',
  'eres',
  'era',
  'eran',
  'fue',
  'fueron',
  'está',
  'están',
  'estaba',
  'estaban',
  'hay',
  'había',
  'hubo',
  'haya',
  'voy',
  'vas',
  'vamos',
  'van',
  'sea',
  'sean',
  'pues',
  'bueno',
  'vale',
  'claro',
  'entonces',
  'así',
  'bien',
  'también',
  'tampoco',
  'cuando',
  'donde',
  'cómo',
])

// Pre-fix, "hour minutes seconds1"(78) topped the list — utterance text leaked
// raw `.srt`-style timecodes. Any candidate token containing a digit is
// suppressed: that's never a content noun phrase.
const TOKEN_HAS_DIGIT_RE = /\d/

/** Extract candidate glossary terms: multiword phrases (2-3 tokens) that recur
 * >= minCount times across utterances. Phrases are dropped when ANY token is
 * a stopword (grammatical glue / filler) OR contains a digit (timestamp noise). */
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
        // Drop the candidate when ANY token is a stopword or has a digit —
        // pre-fix this was `every` (drop only when ALL tokens were stopwords),
        // which let "you know" / "and like" through because of the non-stopword
        // partner. Content noun phrases never contain function words or digits.
        if (gram.some((t) => STOPWORDS.has(t) || TOKEN_HAS_DIGIT_RE.test(t))) continue
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
