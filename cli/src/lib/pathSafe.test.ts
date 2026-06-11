import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import { isContainedUnder } from './pathSafe.js'

describe('isContainedUnder', () => {
  const root = resolve('/seed/sessions')

  it('accepts a path strictly inside the root', () => {
    assert.equal(isContainedUnder(root, resolve(root, 'S001')), true)
    assert.equal(isContainedUnder(root, resolve(root, 'a/b')), true)
  })

  it('rejects the root itself (strict containment)', () => {
    assert.equal(isContainedUnder(root, root), false)
  })

  it('rejects escapes via .. or a sibling/absolute path', () => {
    assert.equal(isContainedUnder(root, resolve(root, '..')), false)
    assert.equal(isContainedUnder(root, resolve(root, '../evil')), false)
    assert.equal(isContainedUnder(root, '/etc/passwd'), false)
  })
})
