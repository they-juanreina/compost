import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCode, endorseArtifact } from './artifacts.js'
import {
  readGitConfig,
  resolveIdentity,
  resolveResearcherId,
  SET_IDENTITY_COMMAND,
} from './identity.js'
import { initSeed } from './seed.js'
import { saveUserConfig, saveUserConfigRaw } from './userConfig.js'

// Every test injects its own env + git reader, so nothing here depends on the
// developer's real $COMPOST_USER, ~/.compost or git identity (CI has none).
const NO_GIT = () => undefined

describe('resolveIdentity / resolveResearcherId (ADR 0008 decision 2)', () => {
  let work: string
  let home: string
  let seed: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-identity-'))
    home = join(work, 'home')
    seed = initSeed('demo', { cwd: work }).path
    env = { COMPOST_HOME: home }
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  const setSeedUser = (toml: string) =>
    writeFileSync(join(seed, '.compost', 'config.toml'), toml, { flag: 'a' })
  const setGlobalUser = (user: Record<string, string>) => saveUserConfigRaw({ user }, env)

  it('refuses with IDENTITY_UNSET and the exact fix when nothing resolves', () => {
    assert.equal(resolveIdentity({ seedPath: seed, env, gitConfig: NO_GIT }), null)
    try {
      resolveResearcherId({ seedPath: seed, env, gitConfig: NO_GIT })
      assert.fail('expected a refusal')
    } catch (err) {
      assert.ok(err instanceof CompostError)
      assert.equal(err.code, 'IDENTITY_UNSET')
      assert.ok(err.message.includes(SET_IDENTITY_COMMAND))
    }
  })

  it('has no $USER or literal "researcher" fallback', () => {
    const withUser = { ...env, USER: 'juanreina' }
    assert.equal(resolveIdentity({ env: withUser, gitConfig: NO_GIT }), null)
  })

  it('resolves in order: flag → $COMPOST_USER → seed → global → git', () => {
    const git = (key: string) => (key === 'user.email' ? 'git@example.com' : 'Git Name')
    const at = () => resolveIdentity({ seedPath: seed, env, gitConfig: git })

    assert.deepEqual(
      { id: at()?.id, source: at()?.source },
      { id: 'git@example.com', source: 'git' },
    )
    setGlobalUser({ email: 'global@example.com', name: 'Global Name' })
    assert.equal(at()?.source, 'global_config')
    assert.equal(at()?.id, 'global@example.com')
    assert.equal(at()?.source_detail, join(home, 'config.toml'))
    setSeedUser('\n[user]\nemail = "seed@example.com"\n')
    assert.equal(at()?.source, 'seed_config')
    assert.equal(at()?.id, 'seed@example.com')
    env.COMPOST_USER = 'env@example.com'
    assert.equal(at()?.source, 'env')
    assert.equal(at()?.id, 'env@example.com')
    const flagged = resolveIdentity({
      explicit: 'flag@example.com',
      seedPath: seed,
      env,
      gitConfig: git,
    })
    assert.equal(flagged?.source, 'flag')
    assert.equal(flagged?.id, 'flag@example.com')
  })

  it('user.name is a display label resolved independently of the email', () => {
    setGlobalUser({ name: 'Juan Reina' })
    const id = resolveIdentity({
      env: { ...env, COMPOST_USER: 'juan@example.com' },
      gitConfig: NO_GIT,
    })
    assert.equal(id?.id, 'juan@example.com', 'identity is the email, never the name')
    assert.equal(id?.name, 'Juan Reina')
  })

  it('blank values do not count as set', () => {
    setGlobalUser({ email: '   ' })
    assert.equal(resolveIdentity({ env: { ...env, COMPOST_USER: '' }, gitConfig: () => '' }), null)
  })

  it('the setup wizard rewriting the global config keeps [user]', () => {
    setGlobalUser({ email: 'global@example.com' })
    saveUserConfig({ defaults: { chat: 'ollama:llama3.1:8b' } }, env)
    assert.equal(resolveIdentity({ env, gitConfig: NO_GIT })?.id, 'global@example.com')
  })

  it('readGitConfig never throws (git missing / key unset / bad cwd)', () => {
    assert.doesNotThrow(() => readGitConfig('compost.definitely-unset-key', join(work, 'nope')))
    assert.equal(readGitConfig('compost.definitely-unset-key', work), undefined)
  })

  it('a researcher endorse uses the resolved id; AI writes need no identity', () => {
    // An AI draft lands with no researcher identity configured at all.
    const prev = process.env.COMPOST_USER
    delete process.env.COMPOST_USER
    try {
      const code = createCode(seed, {
        name: 'distrust',
        definition: 'd',
        author: {
          actorType: 'ai',
          actorId: 'claude-code:0.2.2:abc12345',
          model: 'm',
          promptHash: 'f'.repeat(64),
        },
      })
      mkdirSync(home, { recursive: true })
      setSeedUser('\n[user]\nemail = "seed@example.com"\n')
      const who = resolveResearcherId({ seedPath: seed, env, gitConfig: NO_GIT })
      const res = endorseArtifact(seed, code.id, who)
      assert.equal(res.artifact_id, code.artifact_id)
      assert.equal(who, 'seed@example.com')
    } finally {
      if (prev !== undefined) process.env.COMPOST_USER = prev
    }
  })
})
