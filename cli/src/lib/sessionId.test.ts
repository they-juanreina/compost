import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { assertSessionContained, assertSessionId } from './sessionId.js'

describe('assertSessionId', () => {
  it('accepts bare labels', () => {
    for (const id of ['S001', 'demo', 'a_b-c', 'Session-42', '0', 'A']) {
      assert.doesNotThrow(() => assertSessionId(id))
    }
  })

  it('rejects path separators, traversal, and empty', () => {
    for (const id of ['../escape', '..', '.', 'a/b', 'a\\b', '', 'sess ion', 'a.b', 'foo/../bar']) {
      assert.throws(
        () => assertSessionId(id),
        (e) => e instanceof CompostError && e.code === 'INVALID_INPUT',
        `expected ${JSON.stringify(id)} to be rejected`,
      )
    }
  })
})

describe('assertSessionContained', () => {
  it('returns the absolute session dir for a valid id', () => {
    const dir = assertSessionContained('/seeds/study', 'S001')
    assert.equal(dir, '/seeds/study/sessions/S001')
  })

  it('rejects an id that would escape the seed (belt-and-braces)', () => {
    // assertSessionId already blocks these; the containment check is the backstop.
    assert.throws(
      () => assertSessionContained('/seeds/study', '../../etc'),
      (e) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })
})
