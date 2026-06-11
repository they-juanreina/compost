import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { childEnv, isSecretName, scrubbedEnv } from './childEnv.js'

describe('isSecretName', () => {
  it('flags the well-known names', () => {
    for (const n of ['HUGGINGFACE_TOKEN', 'HF_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      assert.equal(isSecretName(n), true, n)
    }
  })

  it('flags secret-shaped suffixes (future providers)', () => {
    for (const n of ['MISTRAL_API_KEY', 'FOO_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD']) {
      assert.equal(isSecretName(n), true, n)
    }
  })

  it('leaves ordinary env names alone', () => {
    for (const n of ['PATH', 'HOME', 'LANG', 'COMPOST_HOME', 'GIT_AUTHOR_NAME']) {
      assert.equal(isSecretName(n), false, n)
    }
  })
})

describe('scrubbedEnv', () => {
  it('removes secret names, keeps the rest', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-secret',
      HUGGINGFACE_TOKEN: 'hf_secret',
    }
    const out = scrubbedEnv(base)
    assert.equal(out.PATH, '/usr/bin')
    assert.equal(out.HOME, '/home/x')
    assert.equal(out.ANTHROPIC_API_KEY, undefined)
    assert.equal(out.HUGGINGFACE_TOKEN, undefined)
  })
})

describe('childEnv', () => {
  it('re-adds only the allowed secret over a scrubbed base', () => {
    const base = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-other',
    }
    const out = childEnv({ HUGGINGFACE_TOKEN: 'hf_live' }, base)
    assert.equal(out.PATH, '/usr/bin')
    assert.equal(out.HUGGINGFACE_TOKEN, 'hf_live')
    // the cloud keys the child does not need are gone
    assert.equal(out.ANTHROPIC_API_KEY, undefined)
    assert.equal(out.OPENAI_API_KEY, undefined)
  })

  it('drops empty/undefined allow values', () => {
    const out = childEnv({ HUGGINGFACE_TOKEN: '' }, { PATH: '/x' })
    assert.equal('HUGGINGFACE_TOKEN' in out, false)
  })
})
