import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { initSeed } from './seed.js'
import { applyUserConfig, loadUserConfig, saveUserConfig } from './userConfig.js'

describe('userConfig', () => {
  let home: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'compost-userconfig-'))
    env = { COMPOST_HOME: home }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('round-trips defaults through ~/.compost/config.toml', () => {
    assert.equal(loadUserConfig(env), null)
    const path = saveUserConfig({ defaults: { quick_chat: 'ollama:llama3.1:8b' } }, env)
    assert.equal(path, join(home, 'config.toml'))
    assert.deepEqual(loadUserConfig(env)?.defaults, { quick_chat: 'ollama:llama3.1:8b' })
    // merge, not replace
    saveUserConfig({ defaults: { synthesis: 'anthropic:claude-opus-4-7' } }, env)
    assert.deepEqual(loadUserConfig(env)?.defaults, {
      quick_chat: 'ollama:llama3.1:8b',
      synthesis: 'anthropic:claude-opus-4-7',
    })
  })

  it('applyUserConfig overlays [defaults] keys and keeps the rest of the template', () => {
    const template = [
      '[providers.ollama]',
      'base_url = "http://localhost:11434"',
      '',
      '[defaults]',
      'embeddings = "ollama:bge-m3"',
      'quick_chat = "ollama:llama3.1:8b"',
    ].join('\n')
    const out = applyUserConfig(template, { defaults: { quick_chat: 'ollama:qwen3:4b' } })
    assert.match(out, /quick_chat = "ollama:qwen3:4b"/)
    assert.match(out, /embeddings = "ollama:bge-m3"/)
    assert.match(out, /base_url = "http:\/\/localhost:11434"/)
    // no overlay → unchanged input
    assert.equal(applyUserConfig(template, null), template)
  })

  it('compost init inherits the wizard answers into the new seed config', () => {
    saveUserConfig(
      {
        defaults: { quick_chat: 'ollama:qwen3:4b', synthesis: 'ollama:qwen3:4b' },
        providers: { ollama: { timeout_ms: 300000 } },
      },
      env,
    )
    const work = mkdtempSync(join(tmpdir(), 'compost-init-overlay-'))
    try {
      const { path } = initSeed('demo', { cwd: work, env })
      const cfg = readFileSync(join(path, '.compost', 'config.toml'), 'utf8')
      assert.match(cfg, /quick_chat = "ollama:qwen3:4b"/)
      assert.match(cfg, /synthesis = "ollama:qwen3:4b"/)
      assert.match(cfg, /timeout_ms = 300000/)
      assert.match(cfg, /embeddings = "ollama:bge-m3"/) // template value survives
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
