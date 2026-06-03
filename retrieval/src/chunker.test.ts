import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type ChunkerTranscript, chunkTranscript } from './chunker.js'

function u(
  id: string,
  sid: string,
  start: number,
  end: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return { id, speaker_id: sid, start_ms: start, end_ms: end, text, ...extra }
}

const T: ChunkerTranscript = {
  session_id: 'S001',
  utterances: [
    u('U-0001', 'S1', 0, 2000, 'first'),
    u('U-0002', 'S2', 2000, 4000, 'second', { highlight_ids: ['H-1'] }),
    u('U-0003', 'S1', 4000, 6000, 'third'),
  ],
  silences: [],
}

describe('chunkTranscript', () => {
  it('emits a per-utterance chunk with full metadata', () => {
    const chunks = chunkTranscript(T, { seed: 'demo' })
    const utt = chunks.find((c) => c.metadata.chunk_type === 'utterance' && c.text === 'first')
    assert.ok(utt)
    assert.equal(utt.metadata.seed, 'demo')
    assert.equal(utt.metadata.session, 'S001')
    assert.equal(utt.metadata.speaker_id, 'S1')
    assert.equal(utt.metadata.start_ms, 0)
  })

  it('emits 2-neighbor window chunks', () => {
    const chunks = chunkTranscript(T, { seed: 'demo' })
    const windows = chunks.filter((c) => c.metadata.chunk_type === 'window')
    assert.ok(windows.some((w) => w.text.includes('first') && w.text.includes('second')))
  })

  it('emits a per-highlight bonus chunk', () => {
    const chunks = chunkTranscript(T, { seed: 'demo' })
    const hl = chunks.find((c) => c.metadata.chunk_type === 'highlight')
    assert.ok(hl)
    assert.deepEqual(hl.metadata.highlight_ids, ['H-1'])
  })

  it('does not span a silence > 5s in the neighbor window', () => {
    const withSilence: ChunkerTranscript = {
      session_id: 'S001',
      utterances: [u('U-0001', 'S1', 0, 2000, 'before'), u('U-0002', 'S2', 9000, 11000, 'after')],
      silences: [{ start_ms: 2000, end_ms: 9000, duration_ms: 7000 }],
    }
    const chunks = chunkTranscript(withSilence, { seed: 'demo' })
    const windows = chunks.filter((c) => c.metadata.chunk_type === 'window')
    // window for U-0001 must not include 'after'
    assert.ok(!windows.some((w) => w.text.includes('before') && w.text.includes('after')))
  })

  it('emits per-page chunks for document transcripts', () => {
    const doc: ChunkerTranscript = {
      kind: 'document',
      session_id: 'DOC-x',
      utterances: [u('U-0001', 'S1', 0, 0, 'para one', { source_page: 1 })],
    }
    const chunks = chunkTranscript(doc, { seed: 'demo' })
    assert.ok(chunks.some((c) => c.metadata.chunk_type === 'page' && c.metadata.source_page === 1))
  })

  it('emits per-Term glossary chunks', () => {
    const withGloss: ChunkerTranscript = {
      session_id: 'S001',
      utterances: [u('U-0001', 'S1', 0, 1000, 'x')],
      glossary: [{ term_id: 'T-alerta', definition: 'a system warning' }],
    }
    const chunks = chunkTranscript(withGloss, { seed: 'demo' })
    const term = chunks.find((c) => c.metadata.chunk_type === 'term')
    assert.ok(term)
    assert.ok(term.text.includes('T-alerta'))
  })

  it('is idempotent: same input → same chunk ids', () => {
    const a = chunkTranscript(T, { seed: 'demo' }).map((c) => c.id)
    const b = chunkTranscript(T, { seed: 'demo' }).map((c) => c.id)
    assert.deepEqual(a, b)
  })
})
