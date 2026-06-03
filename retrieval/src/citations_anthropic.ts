import type { Claim } from './validator.js'

// Anthropic Citations API path (#42). When the synthesis provider is Anthropic,
// retrieved chunks are sent as document content blocks with citations enabled,
// and the response's citations[] are consumed directly — native enforcement.
// If Anthropic is unavailable, the caller falls through to the schema-bound
// validator (validateWithRetry).

export interface CitableChunk {
  utterance_id: string
  session_id: string
  text: string
}

export interface AnthropicDocBlock {
  type: 'document'
  source: { type: 'text'; media_type: 'text/plain'; data: string }
  title: string
  context: string
  citations: { enabled: true }
}

/** Format chunks as Anthropic document blocks with citations.enabled = true. */
export function toDocumentBlocks(chunks: CitableChunk[]): AnthropicDocBlock[] {
  return chunks.map((c) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: c.text },
    title: `${c.session_id}:${c.utterance_id}`,
    context: `utterance ${c.utterance_id} from session ${c.session_id}`,
    citations: { enabled: true },
  }))
}

interface AnthropicCitation {
  cited_text?: string
  document_title?: string
}

interface AnthropicContentBlock {
  type: string
  text?: string
  citations?: AnthropicCitation[]
}

/** Parse the Anthropic response content blocks into answer text + Claims,
 * mapping each citation's document_title (session:utterance) back to ids. */
export function parseAnthropicCitations(content: AnthropicContentBlock[]): {
  answer: string
  claims: Claim[]
} {
  let answer = ''
  const claims: Claim[] = []
  for (const block of content) {
    if (block.type !== 'text' || block.text === undefined) continue
    answer += block.text
    for (const cite of block.citations ?? []) {
      const title = cite.document_title ?? ''
      const sep = title.indexOf(':')
      if (sep === -1) continue
      const session_id = title.slice(0, sep)
      const utterance_id = title.slice(sep + 1)
      if (!/^U-\d{4,}$/.test(utterance_id)) continue
      claims.push({
        quote: cite.cited_text ?? '',
        utterance_id,
        session_id,
        confidence: 1,
      })
    }
  }
  return { answer: answer.trim(), claims }
}
