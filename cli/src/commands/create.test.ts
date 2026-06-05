import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { resolveAuthor } from './create.js'

describe('resolveAuthor fail-fast for --ai (#165)', () => {
  const HASH = 'a'.repeat(64)

  it('researcher (no --ai) needs nothing extra', () => {
    const a = resolveAuthor({ actorId: 'juan@example.com' })
    assert.equal(a.actorType, 'researcher')
    assert.equal(a.actorId, 'juan@example.com')
  })

  it('--ai without --prompt-hash fails, naming the missing flag', () => {
    const err = catchErr(() =>
      resolveAuthor({ ai: true, actorId: 'claude-code:0.1.0:ab', model: 'm' }),
    )
    assert.ok(err instanceof CompostError)
    assert.equal((err as CompostError).code, 'INVALID_INPUT')
    assert.match((err as CompostError).message, /--prompt-hash/)
  })

  it('--ai without --model fails, naming the missing flag', () => {
    const err = catchErr(() =>
      resolveAuthor({ ai: true, actorId: 'claude-code:0.1.0:ab', promptHash: HASH }),
    )
    assert.match((err as CompostError).message, /--model/)
  })

  it('--ai without --actor-id fails, naming the missing flag', () => {
    const err = catchErr(() => resolveAuthor({ ai: true, model: 'm', promptHash: HASH }))
    assert.match((err as CompostError).message, /--actor-id/)
  })

  it('lists every missing flag at once', () => {
    const err = catchErr(() => resolveAuthor({ ai: true }))
    const msg = (err as CompostError).message
    assert.match(msg, /--actor-id/)
    assert.match(msg, /--model/)
    assert.match(msg, /--prompt-hash/)
  })

  it('rejects a prompt-hash that is not 64-hex', () => {
    const err = catchErr(() =>
      resolveAuthor({ ai: true, actorId: 'x', model: 'm', promptHash: 'not-a-sha' }),
    )
    assert.match((err as CompostError).message, /64-char sha256 hex/)
  })

  it('accepts a complete --ai author', () => {
    const a = resolveAuthor({
      ai: true,
      actorId: 'claude-code:0.1.0:ab',
      model: 'm',
      promptHash: HASH,
    })
    assert.equal(a.actorType, 'ai')
    assert.equal(a.model, 'm')
    assert.equal(a.promptHash, HASH)
  })
})

function catchErr(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw')
}
