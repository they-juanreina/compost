import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { openSeedEvents } from './events.js'
import { validateSeed } from './validate.js'

const VALID_TRANSCRIPT = {
  schema_version: '1.0',
  session_id: 'S001',
  source: 'sessions/S001/source.mp4',
  language: 'en',
  duration_ms: 1000,
  modality: ['audio'],
  speakers: [{ id: 'S1', name: 'Juan', type: 'moderator' }],
  utterances: [{ id: 'U-0001', speaker_id: 'S1', turn: 1, start_ms: 0, end_ms: 500, text: 'hi' }],
  provenance: { transcriber: 'compost-transcriber@0.1.0' },
}

describe('validateSeed (#174)', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-vseed-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  function writeTranscript(sid: string, data: unknown): void {
    const dir = join(seed, 'sessions', sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'transcript.json'), JSON.stringify(data), 'utf8')
  }

  it('passes when every transcript + the event log are valid', () => {
    writeTranscript('S001', VALID_TRANSCRIPT)
    // a valid researcher event
    const w = openSeedEvents(seed)
    w.appendEvent({
      artifact_kind: 'highlight',
      artifact_id: 'a'.repeat(64),
      action: 'create',
      actor_type: 'researcher',
      actor_id: 'juan@x',
      payload: { id: 'H-001' },
    })
    w.close()

    const r = validateSeed(seed)
    assert.equal(r.ok, true)
    assert.equal(r.transcripts.length, 1)
    assert.equal(r.events?.ok, true)
    assert.equal(r.events?.checked, 1)
  })

  it('fails and pinpoints an invalid transcript', () => {
    writeTranscript('S001', VALID_TRANSCRIPT)
    writeTranscript('S002', { schema_version: '1.0', session_id: 'S002' }) // missing required fields
    const r = validateSeed(seed)
    assert.equal(r.ok, false)
    assert.equal(r.transcripts.filter((t) => !t.ok).length, 1)
  })

  it('treats a seed with no event log as events:null (still valid)', () => {
    writeTranscript('S001', VALID_TRANSCRIPT)
    const r = validateSeed(seed)
    assert.equal(r.events, null)
    assert.equal(r.ok, true)
  })
})
