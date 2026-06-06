import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LLMAdapter } from '../llm/adapter.js'
import type { FetchLike } from '../llm/types.js'
import { parseConfig } from './config.js'
import { runDoctor } from './doctor.js'

const CONFIG = `
[providers.ollama]
base_url = "http://localhost:11434"
[defaults]
quick_chat = "ollama:llama3.1:8b"
embeddings = "ollama:bge-m3"
`

function fetchWithModels(models: string[]): FetchLike {
  return async (url) => {
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ models: models.map((name) => ({ name })) }),
        text: async () => '',
      }
    }
    return {
      ok: false,
      status: 404,
      statusText: 'NF',
      json: async () => ({}),
      text: async () => '',
    }
  }
}

describe('runDoctor', () => {
  it('marks tasks ok when the provider is up and the model is present', async () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG), {
      fetchImpl: fetchWithModels(['llama3.1:8b', 'bge-m3']),
    })
    const report = await runDoctor(adapter, parseConfig(CONFIG))
    assert.ok(report.ok)
    assert.ok(report.tasks.every((t) => t.status === 'ok'))
  })

  it('flags model_missing and suggests an ollama pull', async () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG), {
      fetchImpl: fetchWithModels(['llama3.1:8b']), // bge-m3 missing
    })
    const report = await runDoctor(adapter, parseConfig(CONFIG))
    assert.equal(report.ok, false)
    const embed = report.tasks.find((t) => t.task === 'embeddings')
    assert.equal(embed?.status, 'model_missing')
    assert.equal(embed?.suggestion, 'ollama pull bge-m3')
  })

  it('flags provider_down when the provider health check fails', async () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG), {
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        statusText: 'err',
        json: async () => ({}),
        text: async () => 'down',
      }),
    })
    const report = await runDoctor(adapter, parseConfig(CONFIG))
    assert.equal(report.ok, false)
    assert.ok(report.tasks.every((t) => t.status === 'provider_down'))
  })

  it('reconciles the other way: reports pulled-but-unconfigured models (#175)', async () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG), {
      // both configured models present, plus an extra pulled model nothing routes to
      fetchImpl: fetchWithModels(['llama3.1:8b', 'bge-m3', 'qwen2.5:14b']),
    })
    const report = await runDoctor(adapter, parseConfig(CONFIG))
    assert.ok(report.ok)
    assert.deepEqual(report.unused_models.ollama, ['qwen2.5:14b'])
  })

  it('no unused_models entry when every pulled model is configured', async () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG), {
      fetchImpl: fetchWithModels(['llama3.1:8b', 'bge-m3']),
    })
    const report = await runDoctor(adapter, parseConfig(CONFIG))
    assert.deepEqual(report.unused_models, {})
  })

  it('flags unroutable for a malformed route', async () => {
    const cfg = parseConfig(`
[providers.ollama]
base_url = "http://localhost:11434"
[defaults]
quick_chat = "no-colon-here"
`)
    const adapter = new LLMAdapter(cfg, { fetchImpl: fetchWithModels([]) })
    const report = await runDoctor(adapter, cfg)
    assert.equal(report.ok, false)
    assert.equal(report.tasks[0]?.status, 'unroutable')
  })
})
