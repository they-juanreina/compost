import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseCaptionTranscript, parseTextTranscript } from './importTranscript.js'
import { validateTranscript } from './validate.js'

describe('parseTextTranscript (#172)', () => {
  it('parses bracketed, bare, and parenthesized timestamp shapes', () => {
    const raw = [
      '[00:00:01] Juan: Welcome.',
      '0:05 P07: Thanks for having me.',
      'Juan (00:10): How do you feel about the alert?',
    ].join('\n')
    const t = parseTextTranscript(raw, { sessionId: 'S001' })
    assert.equal(t.utterances.length, 3)
    assert.equal(t.speakers.length, 2)
    assert.equal(t.utterances[0]?.start_ms, 1000)
    assert.equal(t.utterances[1]?.start_ms, 5000)
    assert.equal(t.utterances[2]?.start_ms, 10000)
    // first speaker is the moderator; ids assigned in first-seen order
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.speakers[0]?.type, 'moderator')
    assert.equal(t.speakers[1]?.type, 'participant')
    assert.equal(t.utterances[0]?.speaker_id, 'S1')
    assert.equal(t.utterances[1]?.speaker_id, 'S2')
  })

  it('end_ms chains to the next start; last gets a tail', () => {
    const t = parseTextTranscript('[00:00] A: one\n[00:03] B: two', { sessionId: 'S1' })
    assert.equal(t.utterances[0]?.end_ms, 3000)
    assert.ok((t.utterances[1]?.end_ms ?? 0) > 3000)
  })

  it('folds continuation lines into the previous utterance', () => {
    const t = parseTextTranscript('[00:01] Juan: first line\nstill talking', { sessionId: 'S1' })
    assert.equal(t.utterances.length, 1)
    assert.match(t.utterances[0]?.text ?? '', /first line still talking/)
  })

  it('throws when no transcript lines are recognized', () => {
    assert.throws(
      () => parseTextTranscript('just a plain paragraph\nno timestamps', { sessionId: 'S1' }),
      /No "Name: text"/,
    )
  })

  it('produces a schema-valid transcript', () => {
    const work = mkdtempSync(join(tmpdir(), 'compost-import-'))
    try {
      const t = parseTextTranscript('[00:00:01] Juan: hello\n[00:00:04] P07: hi there', {
        sessionId: 'S001',
        language: 'en',
      })
      const p = join(work, 't.json')
      writeFileSync(p, JSON.stringify(t), 'utf8')
      const result = validateTranscript(p)
      assert.equal(result.ok, true, JSON.stringify(result.errors))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('parseCaptionTranscript — WebVTT (.vtt)', () => {
  it('parses cues with <v> voice tags into diarized utterances', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:04.000',
      '<v Juan>Welcome everyone.</v>',
      '',
      '00:00:04.000 --> 00:00:08.500 align:start',
      '<v P07>Thanks for having me.</v>',
    ].join('\n')
    const t = parseCaptionTranscript(vtt, { sessionId: 'S001' })
    assert.equal(t.utterances.length, 2)
    assert.equal(t.speakers.length, 2)
    // explicit caption end times are preserved (not chained/derived)
    assert.equal(t.utterances[0]?.start_ms, 1000)
    assert.equal(t.utterances[0]?.end_ms, 4000)
    assert.equal(t.utterances[1]?.end_ms, 8500)
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.speakers[0]?.type, 'moderator')
    assert.equal(t.utterances[1]?.speaker_id, 'S2')
    assert.equal(t.utterances[0]?.text, 'Welcome everyone.')
  })

  it('handles MM:SS.mmm timestamps and a "Name:" prefix', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000\nJuan: quick note'
    const t = parseCaptionTranscript(vtt, { sessionId: 'S1' })
    assert.equal(t.utterances[0]?.start_ms, 1000)
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.utterances[0]?.text, 'quick note')
  })

  it('un-labelled captions become a single "other" speaker (honest: undiarized)', () => {
    const vtt =
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nfirst line\n\n00:00:02.000 --> 00:00:04.000\nsecond line'
    const t = parseCaptionTranscript(vtt, { sessionId: 'S1' })
    assert.equal(t.utterances.length, 2)
    assert.equal(t.speakers.length, 1)
    assert.equal(t.speakers[0]?.type, 'other')
    assert.equal(t.speakers[0]?.name, undefined)
  })
})

describe('parseCaptionTranscript — SubRip (.srt)', () => {
  it('parses comma-delimited timestamps and strips index/markup', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      '- Juan: Welcome <i>everyone</i>.',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      '{\\an8}- P07: Glad to be here.',
    ].join('\n')
    const t = parseCaptionTranscript(srt, { sessionId: 'S001' })
    assert.equal(t.utterances.length, 2)
    assert.equal(t.utterances[0]?.start_ms, 1000)
    assert.equal(t.utterances[0]?.end_ms, 4000)
    assert.equal(t.speakers[0]?.name, 'Juan')
    assert.equal(t.utterances[0]?.text, 'Welcome everyone.')
    assert.equal(t.utterances[1]?.text, 'Glad to be here.')
  })

  it('produces a schema-valid transcript from a caption file', () => {
    const work = mkdtempSync(join(tmpdir(), 'compost-caption-'))
    try {
      const srt =
        '1\n00:00:01,000 --> 00:00:04,000\nJuan: hello\n\n2\n00:00:04,000 --> 00:00:06,000\nP07: hi'
      const t = parseCaptionTranscript(srt, { sessionId: 'S001', language: 'en' })
      const p = join(work, 't.json')
      writeFileSync(p, JSON.stringify(t), 'utf8')
      const result = validateTranscript(p)
      assert.equal(result.ok, true, JSON.stringify(result.errors))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('throws with a format hint when no cues are recognized', () => {
    assert.throws(
      () => parseCaptionTranscript('just some text\nno timestamps here', { sessionId: 'S1' }),
      /No caption cues/,
    )
  })
})
