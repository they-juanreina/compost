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
    const fetchImpl: FetchLike = async (_url, init) => {
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
    const [rawBody] = bodies
    assert.ok(rawBody)
    const body = JSON.parse(rawBody)
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

  // Ollama returns 404 + `{"error":"model 'X' not found"}` when the model
  // hasn't been pulled. Pre-fix, the user saw a raw HTTP dump — unactionable.
  // After #191 it's a CompostError that names the exact `ollama pull` to run.
  it('translates Ollama 404 model-not-found into an actionable error (#191)', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: "model 'llama3.1:8b' not found" }),
      text: async () => '{"error":"model \'llama3.1:8b\' not found"}',
    })
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    await assert.rejects(
      () => adapter.chat('quick_chat', [{ role: 'user', content: 'hi' }]),
      (e: unknown) =>
        isCompostError(e) &&
        (e as Error).message.includes("'llama3.1:8b'") &&
        /ollama pull llama3\.1:8b/.test((e as Error).message),
    )
  })

  it('translates the embed-path 404 the same way (#191)', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: "model 'bge-m3' not found" }),
      text: async () => '{"error":"model \'bge-m3\' not found"}',
    })
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    await assert.rejects(
      () => adapter.embed('embeddings', ['hello']),
      (e: unknown) => isCompostError(e) && /ollama pull bge-m3/.test((e as Error).message),
    )
  })

  it('maps a 401 from a cloud provider to PROVIDER_AUTH naming the env var (#236)', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-wrong'
    try {
      const fetchImpl: FetchLike = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({}),
        text: async () => '{"error":"invalid x-api-key"}',
      })
      const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
      await assert.rejects(
        () => adapter.chat('synthesis', [{ role: 'user', content: 'hi' }]),
        (e: unknown) =>
          isCompostError(e) &&
          (e as { code: string }).code === 'PROVIDER_AUTH' &&
          /TEST_ANTHROPIC_KEY/.test((e as Error).message) &&
          /401/.test((e as Error).message),
      )
    } finally {
      delete process.env.TEST_ANTHROPIC_KEY
    }
  })

  it('reclassifies anthropic embeddings-unsupported as CONFIG_ERROR (#236)', async () => {
    process.env.TEST_ANTHROPIC_KEY = 'sk-present'
    try {
      // Route embeddings to anthropic to hit the unsupported path.
      const cfg = CONFIG_TOML.replace(
        'embeddings = "ollama:bge-m3"',
        'embeddings = "anthropic:none"',
      )
      const adapter = new LLMAdapter(parseConfig(cfg))
      await assert.rejects(
        () => adapter.embed('embeddings', ['hi']),
        (e: unknown) =>
          isCompostError(e) &&
          (e as { code: string }).code === 'CONFIG_ERROR' &&
          /does not support embeddings/.test((e as Error).message),
      )
    } finally {
      delete process.env.TEST_ANTHROPIC_KEY
    }
  })

  it('lets non-404 Ollama errors propagate untranslated (provider_down etc.)', async () => {
    // 503 from Ollama → keep the original Error so callers can surface it as
    // a service-down problem, not a missing-model problem.
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
      text: async () => 'down',
    })
    const adapter = new LLMAdapter(parseConfig(CONFIG_TOML), { fetchImpl })
    await assert.rejects(
      () => adapter.chat('quick_chat', [{ role: 'user', content: 'hi' }]),
      (e: unknown) => !isCompostError(e) && /503/.test((e as Error).message),
    )
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
