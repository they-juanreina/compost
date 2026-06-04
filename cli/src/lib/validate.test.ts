import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  validateCues,
  validateEventsExport,
  validateFrames,
  validateTranscript,
} from './validate.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'compost-validate-'))
}

const MINIMAL_TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp3',
  language: 'en',
  duration_ms: 10000,
  modality: ['audio'],
  speakers: [{ id: 'S1', name: 'Moderator', type: 'moderator' }],
  utterances: [
    {
      id: 'U-0001',
      speaker_id: 'S1',
      turn: 1,
      start_ms: 0,
      end_ms: 1000,
      text: 'hello',
    },
  ],
  silences: [],
  cues: [],
  frames: [],
  glossary_refs: [],
  // provenance.transcriber is the only required field; frame_capture and
  // frame_annotation are optional strings (omit when not yet wired).
  provenance: {
    transcriber: 'test',
    asr_model: 'test',
    diarizer: 'test',
    audio_cues: 'test',
  },
}

describe('validateTranscript', () => {
  let work: string

  beforeEach(() => {
    work = tmp()
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('accepts a minimal schema-conformant transcript', () => {
    const p = join(work, 'transcript.json')
    writeFileSync(p, JSON.stringify(MINIMAL_TRANSCRIPT))
    const result = validateTranscript(p)
    assert.equal(result.ok, true)
    assert.equal(result.errors, null)
  })

  it('rejects a transcript missing required fields', () => {
    const bad = { ...MINIMAL_TRANSCRIPT } as Record<string, unknown>
    delete bad.session_id
    const p = join(work, 'bad.json')
    writeFileSync(p, JSON.stringify(bad))
    const result = validateTranscript(p)
    assert.equal(result.ok, false)
    assert.ok(result.errors)
  })

  it('errors when the file does not exist', () => {
    assert.throws(() => validateTranscript(join(work, 'nope.json')), /No such file/)
  })

  it('errors when the file is malformed JSON', () => {
    const p = join(work, 'broken.json')
    writeFileSync(p, '{not: valid')
    assert.throws(() => validateTranscript(p), /Failed to parse JSON/)
  })
})

describe('validateCues', () => {
  let work: string
  beforeEach(() => {
    work = tmp()
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('accepts a transcript whose cue kinds are all in the taxonomy', () => {
    const transcript = {
      ...MINIMAL_TRANSCRIPT,
      cues: [
        { id: 'CUE-001', kind: 'laughter', start_ms: 100, end_ms: 200, source: 'audio' },
        { id: 'CUE-002', kind: 'sigh', start_ms: 300, end_ms: 400, source: 'audio' },
      ],
    }
    const p = join(work, 'ok.json')
    writeFileSync(p, JSON.stringify(transcript))
    const result = validateCues(p)
    assert.equal(result.ok, true)
  })

  it('rejects a transcript with a cue kind outside the taxonomy', () => {
    const transcript = {
      ...MINIMAL_TRANSCRIPT,
      cues: [{ id: 'CUE-001', kind: 'eye-roll', start_ms: 100, end_ms: 200, source: 'audio' }],
    }
    const p = join(work, 'bad.json')
    writeFileSync(p, JSON.stringify(transcript))
    const result = validateCues(p)
    assert.equal(result.ok, false)
    assert.ok(Array.isArray(result.errors))
  })
})

describe('validateFrames', () => {
  let work: string
  beforeEach(() => {
    work = tmp()
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('rejects a transcript with a frame trigger outside the taxonomy', () => {
    const transcript = {
      ...MINIMAL_TRANSCRIPT,
      frames: [
        {
          id: 'FR-001',
          at_ms: 1000,
          path: 'sessions/S001/frames/0001000.jpg',
          trigger: 'made_up_trigger',
        },
      ],
    }
    const p = join(work, 'bad.json')
    writeFileSync(p, JSON.stringify(transcript))
    const result = validateFrames(p)
    assert.equal(result.ok, false)
  })

  it('accepts an empty frames array', () => {
    const p = join(work, 'empty.json')
    writeFileSync(p, JSON.stringify(MINIMAL_TRANSCRIPT))
    const result = validateFrames(p)
    assert.equal(result.ok, true)
  })
})

describe('validateEventsExport', () => {
  let work: string
  beforeEach(() => {
    work = tmp()
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const MINIMAL_EVENT = {
    id: '01JM9NPC0000000000000000ZZ',
    ts: '2026-06-03T00:00:00.000Z',
    artifact_kind: 'highlight',
    artifact_id: 'a'.repeat(64),
    action: 'create',
    actor_type: 'researcher',
    actor_id: 'juan@example.com',
    payload: { ok: true },
  }

  it('accepts a single conformant event', () => {
    const p = join(work, 'evt.json')
    writeFileSync(p, JSON.stringify(MINIMAL_EVENT))
    const result = validateEventsExport(p)
    assert.equal(result.ok, true)
  })

  it('accepts an array of conformant events', () => {
    const p = join(work, 'evts.json')
    // Two create events for distinct artifacts (no parent_event required).
    writeFileSync(
      p,
      JSON.stringify([
        MINIMAL_EVENT,
        { ...MINIMAL_EVENT, id: '01JM9NPC0000000000000001ZZ', artifact_id: 'b'.repeat(64) },
      ]),
    )
    const result = validateEventsExport(p)
    assert.equal(result.ok, true)
  })

  it('returns per-index error details on a partial-bad array', () => {
    const bad = { ...MINIMAL_EVENT, action: undefined } as unknown as typeof MINIMAL_EVENT
    const p = join(work, 'mixed.json')
    writeFileSync(p, JSON.stringify([MINIMAL_EVENT, bad]))
    const result = validateEventsExport(p)
    assert.equal(result.ok, false)
    assert.ok(Array.isArray(result.errors))
  })
})
