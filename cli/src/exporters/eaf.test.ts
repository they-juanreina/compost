import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Transcript } from '../lib/transcript.js'
import { transcriptToEaf } from './eaf.js'

const T: Transcript = {
  schema_version: '1.0',
  session_id: 'S023',
  source: 'sessions/S023/source.mp4',
  language: 'es-CO',
  duration_ms: 60000,
  modality: ['audio', 'video'],
  speakers: [
    { id: 'S1', name: 'Juan', type: 'moderator' },
    { id: 'S2', name: 'P07', type: 'participant' },
  ],
  utterances: [
    { id: 'U-0001', speaker_id: 'S1', turn: 1, start_ms: 1000, end_ms: 3000, text: '¿Confías?' },
    {
      id: 'U-0002',
      speaker_id: 'S2',
      turn: 2,
      start_ms: 7000,
      end_ms: 9000,
      text: 'No <del todo>.',
    },
  ],
  silences: [
    { id: 'SIL-1', start_ms: 3000, end_ms: 7000, duration_ms: 4000, context: 'after_question' },
  ],
  cues: [{ id: 'CUE-1', kind: 'laughter', start_ms: 9000, end_ms: 9500, source: 'audio' }],
  frames: [
    {
      id: 'FR-1',
      at_ms: 3500,
      path: 'frames/x.jpg',
      trigger: 'silence_after_question',
      annotation: 'looks down',
    },
  ],
}

describe('transcriptToEaf', () => {
  const eaf = transcriptToEaf(T)

  it('is a well-formed EAF 3.0 document', () => {
    assert.match(eaf, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(eaf, /<ANNOTATION_DOCUMENT[^>]*FORMAT="3\.0"/)
    assert.match(eaf, /<\/ANNOTATION_DOCUMENT>\s*$/)
  })

  it('creates a tier per speaker for utterances', () => {
    assert.match(eaf, /TIER_ID="utterance@Juan"/)
    assert.match(eaf, /TIER_ID="utterance@P07"/)
  })

  it('creates a tier per cue kind, a silence tier, and a frame-annotation tier', () => {
    assert.match(eaf, /TIER_ID="cue@laughter"/)
    assert.match(eaf, /TIER_ID="silence"/)
    assert.match(eaf, /TIER_ID="frame-annotation"/)
  })

  it('emits time slots with the utterance/silence/cue boundaries', () => {
    for (const ms of [1000, 3000, 7000, 9000]) {
      assert.match(eaf, new RegExp(`TIME_VALUE="${ms}"`))
    }
  })

  it('escapes XML special characters in annotation values', () => {
    assert.match(eaf, /No &lt;del todo&gt;\./)
    assert.ok(!eaf.includes('No <del todo>.'))
  })

  it('every annotation references two declared time slots', () => {
    const slotIds = new Set([...eaf.matchAll(/TIME_SLOT_ID="(ts\d+)"/g)].map((m) => m[1]))
    const refs = [...eaf.matchAll(/TIME_SLOT_REF[12]="(ts\d+)"/g)].map((m) => m[1])
    assert.ok(refs.length > 0)
    assert.ok(
      refs.every((r) => slotIds.has(r)),
      'dangling time slot reference',
    )
  })
})
