import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Answer,
  type EvidenceSet,
  INSUFFICIENT_EVIDENCE,
  validateAnswer,
  validateWithRetry,
} from './validator.js'

function evidence(): EvidenceSet {
  return new Map([
    ['U-0001', { session_id: 'S001', text: 'Cuando entra una alerta, no sé si confiar.' }],
    ['U-0002', { session_id: 'S001', text: 'Prefiero verificar manualmente.' }],
  ])
}

const GOOD: Answer = {
  answer: 'Participants distrust automated alerts.',
  claims: [
    { quote: 'no sé si confiar', utterance_id: 'U-0001', session_id: 'S001', confidence: 0.9 },
  ],
}

describe('validateAnswer', () => {
  it('accepts an answer whose quotes substring-match cited utterances', () => {
    assert.ok(validateAnswer(GOOD, evidence()).ok)
  })

  it('rejects a citation not in the retrieval set', () => {
    const bad: Answer = { ...GOOD, claims: [{ ...GOOD.claims[0]!, utterance_id: 'U-0099' }] }
    const r = validateAnswer(bad, evidence())
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('not in the retrieval set')))
  })

  it('rejects a quote that does not substring-match', () => {
    const bad: Answer = { ...GOOD, claims: [{ ...GOOD.claims[0]!, quote: 'I love alerts' }] }
    const r = validateAnswer(bad, evidence())
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('does not substring-match')))
  })

  it('rejects a session mismatch', () => {
    const bad: Answer = { ...GOOD, claims: [{ ...GOOD.claims[0]!, session_id: 'S999' }] }
    assert.equal(validateAnswer(bad, evidence()).ok, false)
  })

  it('rejects schema-invalid input', () => {
    assert.equal(validateAnswer({ answer: 'x' }, evidence()).ok, false)
  })

  it('accepts an explicit insufficient_evidence answer', () => {
    assert.ok(validateAnswer(INSUFFICIENT_EVIDENCE, evidence()).ok)
  })
})

describe('validateWithRetry', () => {
  it('returns immediately when the first answer validates', async () => {
    const res = await validateWithRetry(GOOD, evidence(), {
      regenerate: async () => {
        throw new Error('should not be called')
      },
    })
    assert.equal(res.gaveUp, false)
    assert.equal(res.attempts, 0)
  })

  it('retries with the diff and accepts a corrected answer', async () => {
    const bad: Answer = { ...GOOD, claims: [{ ...GOOD.claims[0]!, quote: 'wrong quote' }] }
    let corrections = 0
    const res = await validateWithRetry(bad, evidence(), {
      regenerate: async (correction) => {
        corrections += 1
        assert.ok(correction.includes('substring-match'))
        return GOOD
      },
    })
    assert.equal(res.gaveUp, false)
    assert.equal(corrections, 1)
  })

  it('gives up with insufficient_evidence after maxRetries', async () => {
    const bad: Answer = { ...GOOD, claims: [{ ...GOOD.claims[0]!, utterance_id: 'U-0099' }] }
    const res = await validateWithRetry(bad, evidence(), {
      regenerate: async () => bad, // never improves
      maxRetries: 3,
    })
    assert.ok(res.gaveUp)
    assert.equal(res.answer.insufficient_evidence, true)
  })
})
