import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { assertRunAllowed } from './setupItem.js'

function catchErr(fn: () => void): unknown {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}

/** The security-relevant gate for `setup item run` — refuse to mutate without an
 * explicit signal, and never accept a renew/set with no value. */
describe('setup item run — invocation guard', () => {
  it('renew with no piped value is refused with a pipe hint', () => {
    const e = catchErr(() =>
      assertRunAllowed('hf-token', 'renew', { human: true, yes: false, value: '' }),
    )
    assert.ok(e instanceof CompostError)
    assert.equal((e as CompostError).code, 'INVALID_INPUT')
    assert.match((e as CompostError).message, /Pipe the new value/)
  })

  it('a mutating action with no TTY and no --yes is refused', () => {
    const e = catchErr(() =>
      assertRunAllowed('hf-token', 'forget', { human: false, yes: false, value: '' }),
    )
    assert.match((e as CompostError).message, /--yes/)
  })

  it('a mutating action is allowed non-interactively WITH --yes', () => {
    assert.equal(
      assertRunAllowed('hf-token', 'forget', { human: false, yes: true, value: '' }),
      undefined,
    )
  })

  it('a mutating action is allowed at a TTY without --yes', () => {
    assert.equal(
      assertRunAllowed('hf-token', 'forget', { human: true, yes: false, value: '' }),
      undefined,
    )
  })

  it('validate (read-only) needs neither a TTY nor --yes', () => {
    assert.equal(
      assertRunAllowed('hf-token', 'validate', { human: false, yes: false, value: '' }),
      undefined,
    )
  })

  it('renew with a value at a TTY is allowed', () => {
    assert.equal(
      assertRunAllowed('hf-token', 'renew', { human: true, yes: false, value: 'hf_x' }),
      undefined,
    )
  })

  it('renew with a value but no TTY still requires --yes (piped, redirected stdout)', () => {
    const e = catchErr(() =>
      assertRunAllowed('hf-token', 'renew', { human: false, yes: false, value: 'hf_x' }),
    )
    assert.match((e as CompostError).message, /--yes/)
  })
})
