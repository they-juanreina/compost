import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { getConfigValue, loadConfig, saveConfig, setConfigValue } from './config.js'
import { initSeed } from './seed.js'

describe('config get/set', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-config-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('getConfigValue resolves nested dotted keys', () => {
    const raw = { providers: { ollama: { base_url: 'http://localhost:11434' } } }
    assert.equal(getConfigValue(raw, 'providers.ollama.base_url'), 'http://localhost:11434')
    assert.equal(getConfigValue(raw, 'providers.ollama.api_key_env'), undefined)
    assert.equal(getConfigValue(raw, 'missing.path.deep'), undefined)
  })

  it('setConfigValue creates missing intermediate sections', () => {
    const raw: Record<string, unknown> = {}
    setConfigValue(raw, 'providers.anthropic.api_key_env', 'ANTHROPIC_API_KEY')
    assert.deepEqual(raw, {
      providers: { anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
    })
  })

  it('setConfigValue coerces booleans, integers, and JSON arrays', () => {
    const raw: Record<string, unknown> = {}
    setConfigValue(raw, 'features.experimental', 'true')
    setConfigValue(raw, 'limits.max_workers', '4')
    setConfigValue(raw, 'kinds', '["a","b"]')
    setConfigValue(raw, 'note', 'plain string')
    assert.equal(raw.features && (raw.features as Record<string, unknown>).experimental, true)
    assert.equal(raw.limits && (raw.limits as Record<string, unknown>).max_workers, 4)
    assert.deepEqual(raw.kinds, ['a', 'b'])
    assert.equal(raw.note, 'plain string')
  })

  it('saveConfig + loadConfig round-trip a write', () => {
    const { path } = initSeed('demo', { cwd: work })
    const config = loadConfig(path)
    setConfigValue(config.raw, 'defaults.embeddings', 'ollama:bge-m3:q4_k_m')
    saveConfig(path, config.raw)
    const reloaded = loadConfig(path)
    assert.equal(getConfigValue(reloaded.raw, 'defaults.embeddings'), 'ollama:bge-m3:q4_k_m')
    // The on-disk file is valid TOML the next reader can parse.
    const onDisk = readFileSync(join(path, '.compost', 'config.toml'), 'utf8')
    assert.match(onDisk, /defaults/)
  })

  it('saveConfig preserves other keys when one is modified', () => {
    const { path } = initSeed('demo', { cwd: work })
    const config = loadConfig(path)
    // The default config has providers + defaults sections; verify both survive.
    assert.ok(Object.keys(config.raw).length > 0)
    setConfigValue(config.raw, 'defaults.synthesis', 'anthropic:claude-opus-4-7')
    saveConfig(path, config.raw)
    const reloaded = loadConfig(path)
    assert.equal(getConfigValue(reloaded.raw, 'defaults.synthesis'), 'anthropic:claude-opus-4-7')
    // Original providers section still present
    assert.ok(Object.keys(reloaded.providers).length > 0)
  })
})

// Dispatch tests for .txt and .xlsx live in ingest.test.ts alongside the
// existing `describe('classify', ...)` block.
