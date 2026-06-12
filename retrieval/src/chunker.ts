import { createHash } from 'node:crypto'

import type { Chunk, ChunkMetadata, SourceAttribution } from './types.js'

export const CHUNKER_VERSION = '1'

// A silence longer than this is a semantic boundary: a neighbor window must
// not span it.
export const SILENCE_BOUNDARY_MS = 5000

export interface ChunkerTranscript {
  kind?: 'session' | 'document'
  session_id: string
  /** Author/citation of a sourced document (#270); absent for recordings. */
  attribution?: SourceAttribution
  utterances: Array<{
    id: string
    speaker_id: string
    start_ms: number
    end_ms: number
    text: string
    source_page?: number
    highlight_ids?: string[]
    code_ids?: string[]
  }>
  silences?: Array<{ start_ms: number; end_ms: number; duration_ms: number }>
  glossary?: Array<{ term_id: string; definition: string }>
}

export interface ChunkerOptions {
  seed: string
  neighborRadius?: number // default 2
  actorType?: ChunkMetadata['actor_type']
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Deterministic chunk id from content + chunker version → idempotent re-chunking. */
function chunkId(text: string, type: string): string {
  return `${type}:${sha(`${CHUNKER_VERSION}:${type}:${text}`).slice(0, 16)}`
}

function bigSilenceBetween(
  silences: NonNullable<ChunkerTranscript['silences']>,
  fromMs: number,
  toMs: number,
): boolean {
  const lo = Math.min(fromMs, toMs)
  const hi = Math.max(fromMs, toMs)
  return silences.some(
    (s) => s.duration_ms > SILENCE_BOUNDARY_MS && s.start_ms >= lo && s.end_ms <= hi,
  )
}

export function chunkTranscript(transcript: ChunkerTranscript, opts: ChunkerOptions): Chunk[] {
  const radius = opts.neighborRadius ?? 2
  const actorType = opts.actorType ?? 'agent'
  const utts = transcript.utterances
  const silences = transcript.silences ?? []
  const chunks: Chunk[] = []
  const seen = new Set<string>()

  const push = (
    text: string,
    type: ChunkMetadata['chunk_type'],
    u: ChunkerTranscript['utterances'][number] | null,
    extra: Partial<ChunkMetadata> = {},
  ) => {
    const id = chunkId(text, type)
    if (seen.has(id)) return
    seen.add(id)
    chunks.push({
      id,
      text,
      text_sha: sha(text),
      metadata: {
        seed: opts.seed,
        session: transcript.session_id,
        speaker_id: u?.speaker_id ?? null,
        start_ms: u?.start_ms ?? null,
        end_ms: u?.end_ms ?? null,
        source_page: u?.source_page ?? null,
        highlight_ids: u?.highlight_ids ?? [],
        code_ids: u?.code_ids ?? [],
        actor_type: actorType,
        chunk_type: type,
        // Sourced-document attribution rides every chunk's metadata so a
        // retrieval hit over sourced material can name its author (#270).
        ...(transcript.attribution !== undefined ? { attribution: transcript.attribution } : {}),
        ...extra,
      },
    })
  }

  for (let i = 0; i < utts.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is provably in-bounds (0 <= i < utts.length) inside the for-loop
    const u = utts[i]!
    // primary per-utterance chunk
    push(u.text, 'utterance', u)

    // 2-neighbor window, not crossing a >5s silence
    const windowParts: string[] = []
    for (let j = Math.max(0, i - radius); j <= Math.min(utts.length - 1, i + radius); j++) {
      // biome-ignore lint/style/noNonNullAssertion: j is bounded by Math.min(utts.length - 1, ...) so the index is in-bounds
      const nb = utts[j]!
      if (j !== i && bigSilenceBetween(silences, u.start_ms, nb.start_ms)) continue
      windowParts.push(nb.text)
    }
    if (windowParts.length > 1) push(windowParts.join(' '), 'window', u)

    // per-highlight bonus chunk (one per highlight covering this utterance)
    for (const _hid of u.highlight_ids ?? []) {
      push(u.text, 'highlight', u, { highlight_ids: [_hid] })
    }

    // per-page chunk for documents
    if (transcript.kind === 'document' && u.source_page !== undefined) {
      push(u.text, 'page', u)
    }
  }

  // per-Term glossary chunks
  for (const term of transcript.glossary ?? []) {
    const text = `${term.term_id}: ${term.definition}`
    push(text, 'term', null)
    const last = chunks[chunks.length - 1]
    if (last !== undefined && last.metadata.chunk_type === 'term') {
      last.metadata.code_ids = []
    }
  }

  return chunks
}
