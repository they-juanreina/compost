import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAnswer } from './chat.js'

describe('parseAnswer', () => {
  it('parses bare JSON', () => {
    const a = parseAnswer('{"answer":"x","claims":[]}')
    assert.equal(a.answer, 'x')
    assert.equal(a.insufficient_evidence, undefined)
  })

  it('strips a ```json fence (local models emit one despite the schema)', () => {
    const a = parseAnswer(
      '```json\n{"answer":"hi","claims":[{"utterance_id":"U-1","quote":"q","confidence":0.9}]}\n```',
    )
    assert.equal(a.answer, 'hi')
    assert.equal(a.claims.length, 1)
  })

  it('extracts the JSON object when wrapped in prose/preamble', () => {
    const a = parseAnswer(
      'Here is the answer:\n```json\n{"answer":"hi","claims":[]}\n```\nHope that helps!',
    )
    assert.equal(a.answer, 'hi')
    assert.equal(a.insufficient_evidence, undefined)
  })

  it('falls back to insufficient_evidence on unparseable output', () => {
    const a = parseAnswer('I cannot answer that.')
    assert.equal(a.insufficient_evidence, true)
    assert.equal(a.claims.length, 0)
  })

  it('treats a bare non-object JSON primitive as insufficient (not a propagated value)', () => {
    for (const t of ['null', '42', '"hi"', '[1,2]']) {
      const a = parseAnswer(t)
      assert.equal(a.insufficient_evidence, true, `${t} should be insufficient`)
    }
  })
})
