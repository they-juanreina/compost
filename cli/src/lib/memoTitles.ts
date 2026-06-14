import { cosineSimilarity, meanVector } from '@they-juanreina/compost-retrieval'

import { LLMAdapter } from '../llm/adapter.js'
import { updateArtifact } from './artifacts.js'
import { loadConfig } from './config.js'
import type { Author } from './events.js'
import { getMemo } from './memos.js'

/**
 * Embedding-extractive memo titles (#315, ADR 0004 §5 fallback chain). The
 * middle tier of `displayTitle`: for a memo with no human title, pick the most
 * *central* sentence of its body as a `suggested_title` so scanning `memo list`
 * shows a sharp phrase, not just the first line.
 *
 * This is an **extractive computation**, not generated prose (it selects a span
 * verbatim from the memo's own text) — a local capability like `category
 * suggest`'s clustering, which keeps it on the right side of §2 ("not the
 * analyst"). `suggested_title` is an un-gated display convenience; a human or
 * agent title always overrides it. Generative titling stays in the agent layer
 * (#312); compost's core never writes interpretive prose.
 */

const TITLE_MAX = 80

function clip(s: string, max = TITLE_MAX): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * Title-candidate spans from a memo body: markdown-heading lines first (a `# `
 * line is an explicit candidate), then sentence-ish fragments, deduped and
 * length-filtered. Order is preserved so a single-candidate body returns it
 * without needing embeddings.
 */
export function titleCandidates(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const t = raw
      .trim()
      .replace(/^#+\s*/, '')
      .trim()
    if (t.length < 3) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    // Split a line into sentence-ish fragments on . ! ? ; — keeps candidates short.
    const frags = line.split(/(?<=[.!?;])\s+/)
    for (const f of frags) push(f)
  }
  return out
}

export type Embedder = (texts: string[]) => Promise<number[][]>

/**
 * The extractive title: the candidate whose embedding is closest to the body's
 * centroid (the "most representative" sentence), clipped to a title length.
 * Pure but for the injected `embed` — unit-testable with a fake embedder. Returns
 * null when the body has no usable candidate.
 */
export async function extractiveTitle(
  content: string,
  embed: Embedder,
  max = TITLE_MAX,
): Promise<string | null> {
  const cands = titleCandidates(content)
  if (cands.length === 0) return null
  if (cands.length === 1) return clip(cands[0] as string, max)

  const vecs = await embed(cands)
  if (vecs.length !== cands.length || vecs.some((v) => v.length === 0)) {
    return clip(cands[0] as string, max) // degraded embedder → first candidate
  }
  const centroid = meanVector(vecs)
  let best = 0
  let bestScore = Number.NEGATIVE_INFINITY
  for (let i = 0; i < vecs.length; i++) {
    const score = cosineSimilarity(vecs[i] as number[], centroid)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return clip(cands[best] as string, max)
}

export interface SuggestTitleResult {
  id: string
  updated: boolean
  suggested_title?: string
  /** Why nothing changed, when `updated` is false. */
  skipped?: 'has-title' | 'unchanged' | 'no-candidate'
}

/**
 * Compute + store an embedding-extractive `suggested_title` for a memo that has
 * no human title, via the local embeddings provider (Ollama). Emits an `update`
 * event (no silent writes, §13); a human title always wins, so a titled memo is
 * a no-op. Throws CompostError if the memo is missing; surfaces the provider
 * error if embeddings are unavailable (the caller asked for it explicitly).
 */
export async function suggestMemoTitle(
  seedPath: string,
  ref: string,
  author: Author,
): Promise<SuggestTitleResult> {
  const memo = getMemo(seedPath, ref)
  if (memo === null) {
    const { CompostError } = await import('../errors.js')
    throw new CompostError('FILE_NOT_FOUND', `No memo "${ref}" in this seed.`)
  }
  const id = memo.id
  if (memo.title.trim().length > 0) return { id, updated: false, skipped: 'has-title' }

  const adapter = new LLMAdapter(loadConfig(seedPath))
  const embed: Embedder = async (texts) => (await adapter.embed('embeddings', texts)).vectors
  const title = await extractiveTitle(memo.content, embed)
  if (title === null) return { id, updated: false, skipped: 'no-candidate' }
  if (title === memo.suggested_title)
    return { id, updated: false, suggested_title: title, skipped: 'unchanged' }

  updateArtifact(
    seedPath,
    ref,
    { field: 'suggested_title', before: memo.suggested_title ?? null, after: title },
    author,
  )
  return { id, updated: true, suggested_title: title }
}
