import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CompostError } from '../errors.js'
import {
  DEFAULT_EMBED_BATCH_CAP,
  getConfigValue,
  loadConfig,
  parseConfig,
  providerEmbedBatchCap,
  saveConfig,
  setConfigValue,
} from './config.js'
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

  it('setConfigValue default behavior is always-string (no coercion)', () => {
    const raw: Record<string, unknown> = {}
    setConfigValue(raw, 'features.experimental', 'true')
    setConfigValue(raw, 'limits.max_workers', '4')
    setConfigValue(raw, 'kinds', '["a","b"]')
    setConfigValue(raw, 'note', 'plain string')
    // Every value is the literal string the user typed — no silent type drift.
    assert.equal(raw.features && (raw.features as Record<string, unknown>).experimental, 'true')
    assert.equal(raw.limits && (raw.limits as Record<string, unknown>).max_workers, '4')
    assert.equal(raw.kinds, '["a","b"]')
    assert.equal(raw.note, 'plain string')
  })

  it('setConfigValue coerces correctly when an explicit type is passed', () => {
    const raw: Record<string, unknown> = {}
    setConfigValue(raw, 'features.experimental', 'true', 'bool')
    setConfigValue(raw, 'limits.max_workers', '4', 'int')
    setConfigValue(raw, 'limits.ratio', '0.75', 'float')
    setConfigValue(raw, 'kinds', '["a","b"]', 'json')
    setConfigValue(raw, 'note', '1', 'string') // force string even if numeric-looking
    assert.equal(raw.features && (raw.features as Record<string, unknown>).experimental, true)
    assert.equal(raw.limits && (raw.limits as Record<string, unknown>).max_workers, 4)
    assert.equal(raw.limits && (raw.limits as Record<string, unknown>).ratio, 0.75)
    assert.deepEqual(raw.kinds, ['a', 'b'])
    assert.equal(raw.note, '1')
  })

  it('setConfigValue throws on type-mismatch input', () => {
    const raw: Record<string, unknown> = {}
    assert.throws(() => setConfigValue(raw, 'k', 'yes', 'bool'), /requires "true" or "false"/)
    assert.throws(() => setConfigValue(raw, 'k', '3.5', 'int'), /requires an integer/)
    assert.throws(() => setConfigValue(raw, 'k', 'not json', 'json'), /invalid JSON/)
  })

  it('saveConfig + loadConfig round-trip a write', () => {
    const { path } = initSeed('demo', { cwd: work })
    const config = loadConfig(path)
    setConfigValue(config.raw, 'defaults.embeddings', 'ollama:bge-m3')
    saveConfig(path, config.raw)
    const reloaded = loadConfig(path)
    assert.equal(getConfigValue(reloaded.raw, 'defaults.embeddings'), 'ollama:bge-m3')
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

describe('providerEmbedBatchCap', () => {
  it('defaults to DEFAULT_EMBED_BATCH_CAP (128) when unset', () => {
    const cfg = parseConfig('[providers.ollama]\nbase_url = "http://localhost:11434"\n')
    assert.equal(DEFAULT_EMBED_BATCH_CAP, 128)
    assert.equal(providerEmbedBatchCap(cfg, 'ollama'), 128)
    assert.equal(providerEmbedBatchCap(cfg, 'never-configured'), 128)
  })

  it('reads providers.<name>.embed_batch_cap per provider', () => {
    const cfg = parseConfig(
      '[providers.ollama]\nembed_batch_cap = 64\n\n[providers.openai]\nembed_batch_cap = 2048\n',
    )
    assert.equal(providerEmbedBatchCap(cfg, 'ollama'), 64)
    assert.equal(providerEmbedBatchCap(cfg, 'openai'), 2048)
    assert.equal(providerEmbedBatchCap(cfg, 'lmstudio'), DEFAULT_EMBED_BATCH_CAP)
  })

  it('rejects a set-but-invalid cap with an actionable CONFIG_ERROR', () => {
    for (const literal of ['0', '-5', '2.5', '"128"', 'true']) {
      const cfg = parseConfig(`[providers.ollama]\nembed_batch_cap = ${literal}\n`)
      assert.throws(
        () => providerEmbedBatchCap(cfg, 'ollama'),
        (e: unknown) =>
          e instanceof CompostError &&
          e.code === 'CONFIG_ERROR' &&
          /providers\.ollama\.embed_batch_cap/.test(e.message) &&
          /--type=int/.test(e.message),
        `embed_batch_cap = ${literal} should be rejected`,
      )
    }
  })
})
