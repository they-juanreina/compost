import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { applyLabels, applySidecar, labelSession, readSidecar, sidecarPath } from './speakers.js'
import type { Transcript } from './transcript.js'

function transcript(): Transcript {
  return {
    schema_version: '1.0',
    session_id: 'S001',
    source: 'sessions/S001/source.mp4',
    language: 'en',
    duration_ms: 1000,
    modality: ['audio'],
    speakers: [
      { id: 'SPEAKER_00', name: 'SPEAKER_00', type: 'moderator' },
      { id: 'SPEAKER_01', name: 'SPEAKER_01', type: 'participant' },
    ],
    utterances: [],
  } as unknown as Transcript
}

describe('applyLabels', () => {
  it('renames matching speakers and reports unmatched map keys', () => {
    const t = transcript()
    const r = applyLabels(t, { SPEAKER_00: { name: 'Juan' }, SPEAKER_99: { name: 'Nobody' } })
    assert.deepEqual(r.applied, ['SPEAKER_00'])
    assert.deepEqual(r.unmatched, ['SPEAKER_99'])
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.speakers[1]?.name, 'SPEAKER_01') // untouched
  })

  it('applies type when provided', () => {
    const t = transcript()
    applyLabels(t, { SPEAKER_01: { name: 'P07', type: 'participant' } })
    assert.equal(t.speakers[1]?.name, 'P07')
    assert.equal(t.speakers[1]?.type, 'participant')
  })
})

describe('labelSession + applySidecar (re-apply on re-transcribe)', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-label-'))
  })
  afterEach(() => rmSync(seed, { recursive: true, force: true }))

  function writeTranscript(t: Transcript): string {
    const dir = join(seed, 'sessions', 'S001')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'transcript.json')
    writeFileSync(p, JSON.stringify(t), 'utf8')
    return p
  }

  it('writes names into transcript.json and persists a sidecar', () => {
    writeTranscript(transcript())
    const r = labelSession(seed, 'S001', { SPEAKER_00: { name: 'Juan' } })
    assert.deepEqual(r.applied, ['SPEAKER_00'])
    const t = JSON.parse(readFileSync(r.transcript_path, 'utf8')) as Transcript
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.deepEqual(readSidecar(sidecarPath(seed, 'S001')), { SPEAKER_00: { name: 'Juan' } })
  })

  it('merges successive label calls into the sidecar', () => {
    writeTranscript(transcript())
    labelSession(seed, 'S001', { SPEAKER_00: { name: 'Juan' } })
    labelSession(seed, 'S001', { SPEAKER_01: { name: 'P07' } })
    assert.deepEqual(readSidecar(sidecarPath(seed, 'S001')), {
      SPEAKER_00: { name: 'Juan' },
      SPEAKER_01: { name: 'P07' },
    })
  })

  it('re-applies the sidecar to a freshly-(re)transcribed transcript', () => {
    const p = writeTranscript(transcript())
    labelSession(seed, 'S001', { SPEAKER_00: { name: 'Juan' }, SPEAKER_01: { name: 'P07' } })
    // simulate re-transcription overwriting names back to cluster ids
    writeFileSync(p, JSON.stringify(transcript()), 'utf8')
    const applied = applySidecar(p)
    assert.deepEqual(applied.sort(), ['SPEAKER_00', 'SPEAKER_01'])
    const t = JSON.parse(readFileSync(p, 'utf8')) as Transcript
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.speakers[1]?.name, 'P07')
  })

  it('applySidecar is a no-op when there is no sidecar', () => {
    const p = writeTranscript(transcript())
    assert.deepEqual(applySidecar(p), [])
  })

  it('errors when labeling a session with no transcript', () => {
    assert.throws(() => labelSession(seed, 'S404', { SPEAKER_00: { name: 'X' } }), /No transcript/)
  })
})
