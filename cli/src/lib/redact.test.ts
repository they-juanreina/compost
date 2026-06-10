import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { redactSecrets } from './redact.js'

describe('redactSecrets', () => {
  it('masks common token shapes', () => {
    assert.match(redactSecrets('token=hf_abcdef123456 done', {}), /«redacted»/)
    assert.match(redactSecrets('key sk-ABCdef_12345678 here', {}), /«redacted»/)
    assert.match(redactSecrets('Authorization: Bearer abc.def-ghi_123', {}), /«redacted»/)
    assert.doesNotMatch(redactSecrets('token=hf_abcdef123456 done', {}), /hf_abcdef/)
  })

  it('masks the concrete value of a secret-shaped env var wherever it appears', () => {
    const env = { ANTHROPIC_API_KEY: 'supersecretvalue123', PATH: '/usr/bin' }
    const out = redactSecrets('POST → 401: {"key":"supersecretvalue123"}', env)
    assert.doesNotMatch(out, /supersecretvalue123/)
    assert.match(out, /«redacted»/)
  })

  it('leaves ordinary text untouched', () => {
    const text = 'GET /api → 404 Not Found: no such session S001'
    assert.equal(redactSecrets(text, { PATH: '/usr/bin' }), text)
  })

  it('does not mask short innocuous env values', () => {
    const env = { FOO_TOKEN: 'ab' } // below the 6-char floor
    assert.equal(redactSecrets('value ab here', env), 'value ab here')
  })
})
