import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isCompostError } from '../errors.js'
import { parseConfig } from '../lib/config.js'
import { LLMAdapter } from './adapter.js'
import type { FetchLike } from './types.js'

const CONFIG_TOML = `
schema_version = "1.0"

[providers.ollama]
base_url = "http://localhost:11434"

[providers.anthropic]
api_key_env = "TEST_ANTHROPIC_KEY"

[defaults]
embeddings = "ollama:bge-m3"
quick_chat = "ollama:llama3.1:8b"
synthesis  = "anthropic:claude-opus-4-7"
`

interface StubRoute {
  match: (url: string) => boolean
  status?: number
  json: unknown
}

function stubFetch(routes: StubRoute[], log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init?.method ?? 'GET'} ${url}`)
    const route = routes.find((r) => r.match(url))
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
        text: async () => `no stub for ${url}`,
      }
    }
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => route.json,
      text: async () => JSON.stringify(route.json),
    }
  }
}

describe('LLMAdapter routing', () => {
  it('resolves each task to its provider:model from [defaults]', () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML))
    assert.deepEqual(adapter.resolveTask('quick_chat'), {
      provider: 'ollama',
      model: 'llama3.1:8b',
    })
    assert.deepEqual(adapter.resolveTask('synthesis'), {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    })
    assert.deepEqual(adapter.resolveTask('embeddings'), {
      provider: 'ollama',
      model: 'bge-m3',
    })
  })

  it('throws for an unconfigured task', () => {
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML))
    assert.throws(() => adapter.resolveTask('frame-annotation'), /No route configured/)
  })

  it('routes a chat call to the Ollama driver and returns its content', async () => {
    const log: string[] = []
    const fetchImpl = stubFetch(
      [{ match: (u) => u.endsWith('/api/chat'), json: { message: { content: 'hola' } } }],
      log,
    )
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const res = await adapter.chat('quick_chat', [{ role: 'user', content: 'hi' }])
    assert.equal(res.text, 'hola')
    assert.equal(res.provider, 'ollama')
    assert.equal(res.model, 'llama3.1:8b')
    assert.ok(log.some((l) => l.includes('POST') && l.includes('/api/chat')))
  })

  it('routes an embeddings call and returns vectors', async () => {
    const fetchImpl = stubFetch([
      { match: (u) => u.endsWith('/api/embed'), json: { embeddings: [[0.1, 0.2, 0.3]] } },
    ])
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const res = await adapter.embed('embeddings', ['text'])
    assert.deepEqual(res.vectors, [[0.1, 0.2, 0.3]])
  })

  it('routes synthesis to Anthropic with system/messages split', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-test' // satisfy the missing-key guard
    const bodies: string[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      bodies.push(init?.body ?? '')
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ content: [{ type: 'text', text: 'synthesized' }] }),
        text: async () => '',
      }
    }
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const res = await adapter.chat('synthesis', [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'summarize' },
    ])
    assert.equal(res.text, 'synthesized')
    const body = JSON.parse(bodies[0]!)
    assert.equal(body.system, 'be terse')
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].role, 'user')
  })

  it('fails with an actionable error when a cloud task lacks its API key', async () => {
    delete process.env.TEST_ANTHROPIC_KEY
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML))
    await assert.rejects(
      () => adapter.chat('synthesis', [{ role: 'user', content: 'hi' }]),
      (e: unknown) =>
        isCompostError(e) && /needs an API key.*TEST_ANTHROPIC_KEY/s.test((e as Error).message),
    )
  })

  it('treats a blank/whitespace API key as missing', async () => {
    process.env.TEST_ANTHROPIC_KEY = '   '
    try {
      const adapter = new LLMAdapter(parseConfig(CONFIG_TOML))
      await assert.rejects(
        () => adapter.chat('synthesis', [{ role: 'user', content: 'hi' }]),
        (e: unknown) => isCompostError(e) && /needs an API key/.test((e as Error).message),
      )
    } finally {
      delete process.env.TEST_ANTHROPIC_KEY
    }
  })

  it('does not require an API key for a local task', async () => {
    delete process.env.TEST_ANTHROPIC_KEY
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: { content: 'local answer' } }),
      text: async () => '',
    })
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const res = await adapter.chat('quick_chat', [{ role: 'user', content: 'hi' }])
    assert.equal(res.text, 'local answer')
  })

  it('healthAll probes every provider referenced by defaults', async () => {
    const fetchImpl = stubFetch([
      { match: (u) => u.endsWith('/api/tags'), json: { models: [{ name: 'llama3.1:8b' }] } },
      { match: (u) => u.includes('/v1/models'), json: { data: [{ id: 'claude-opus-4-7' }] } },
    ])
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const health = await adapter.healthAll()
    assert.equal(health.ollama?.ok, true)
    assert.deepEqual(health.ollama?.model_list, ['llama3.1:8b'])
    assert.equal(health.anthropic?.ok, true)
  })

  it('reports a provider as down when its health endpoint errors', async () => {
    const fetchImpl = stubFetch([]) // everything 404s
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    const health = await adapter.healthAll()
    assert.equal(health.ollama?.ok, false)
    assert.ok(health.ollama?.error)
  })
})
