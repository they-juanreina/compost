import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CompostError } from '../errors.js'
import { CSV_COLUMNS } from '../exporters/csv.js'
import { exportTranscript, loadTranscript } from './export.js'
import type { Transcript } from './transcript.js'

const SAMPLE: Transcript = {
  schema_version: '1.0',
  session_id: 'S023',
  source: 'sessions/S023/source.mp4',
  language: 'es-CO',
  duration_ms: 600000,
  modality: ['audio', 'video'],
  speakers: [
    { id: 'S1', name: 'Juan', type: 'moderator' },
    { id: 'S2', name: 'P07', type: 'participant' },
  ],
  utterances: [
    {
      id: 'U-0001',
      speaker_id: 'S1',
      turn: 1,
      start_ms: 1000,
      end_ms: 3000,
      text: '¿Cómo te sientes con las alertas?',
    },
    {
      id: 'U-0002',
      speaker_id: 'S2',
      turn: 2,
      start_ms: 7000,
      end_ms: 12000,
      text: 'No sé si confiar, la verdad.',
      annotation: 'Voice trails off.',
    },
  ],
  silences: [
    { id: 'SIL-1', start_ms: 3000, end_ms: 7000, duration_ms: 4000, context: 'after_question' },
  ],
  cues: [{ id: 'CUE-1', kind: 'laughter', start_ms: 12000, end_ms: 13000, source: 'audio' }],
}

describe('exportTranscript csv', () => {
  it('emits the legacy fact_utterances column header in order', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'csv' })
    const header = content.split('\n')[0]
    assert.equal(header, CSV_COLUMNS.join(','))
  })

  it('emits one row per utterance with resolved speaker name/type and counts', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'csv', createdDate: '2026-06-02' })
    const lines = content.trim().split('\n')
    assert.equal(lines.length, 3) // header + 2 utterances
    // U-0002 row
    const row = lines[2] ?? ''
    assert.match(row, /^U-0002,S023,S2,P07,participant,2,/)
    assert.match(row, /2026-06-02$/)
  })

  it('quotes cells containing commas', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'csv' })
    // U-0002 text has a comma -> must be quoted
    assert.match(content, /"No sé si confiar, la verdad\."/)
  })

  it('computes word_count and char_count', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'csv' })
    const lines = content.trim().split('\n')
    // U-0001: "¿Cómo te sientes con las alertas?" => 6 words
    const fields = lines[1]?.split(',') ?? []
    const wc = Number(fields[7])
    assert.equal(wc, 6)
  })
})

describe('exportTranscript md', () => {
  it('inlines silences and cues interleaved with utterances by timestamp', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'md' })
    assert.match(content, /# S023/)
    assert.match(content, /\*\*Juan:\*\* ¿Cómo te sientes/)
    assert.match(content, /_\[silence 4\.0s — after_question\]_/)
    assert.match(content, /_\[laughter\]_/)
    // ordering: question (1000) < silence (3000) < answer (7000) < laughter (12000)
    const iQ = content.indexOf('¿Cómo')
    const iSil = content.indexOf('[silence')
    const iA = content.indexOf('No sé')
    const iLaugh = content.indexOf('[laughter]')
    assert.ok(iQ < iSil && iSil < iA && iA < iLaugh, 'timeline order wrong')
  })

  it('renders the per-utterance annotation as a blockquote', () => {
    const { content } = exportTranscript(SAMPLE, { format: 'md' })
    assert.match(content, /Voice trails off\./)
  })
})

describe('loadTranscript', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-export-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('loads a valid transcript', () => {
    const p = join(work, 't.json')
    writeFileSync(p, JSON.stringify(SAMPLE))
    const t = loadTranscript(p)
    assert.equal(t.session_id, 'S023')
  })

  it('throws FILE_NOT_FOUND for a missing path', () => {
    assert.throws(() => loadTranscript(join(work, 'ghost.json')), CompostError)
  })

  it('throws on malformed JSON', () => {
    const p = join(work, 'bad.json')
    writeFileSync(p, '{not json')
    assert.throws(() => loadTranscript(p), CompostError)
  })

  it('throws SCHEMA_VIOLATION when required fields are missing', () => {
    const p = join(work, 'incomplete.json')
    writeFileSync(p, JSON.stringify({ foo: 'bar' }))
    assert.throws(() => loadTranscript(p), CompostError)
  })
})
