import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FetchLike } from '../llm/types.js'
import { secretsEnvPath, setSecret } from './secrets.js'
import { initSeed } from './seed.js'
import { runSetup, type SetupCheck } from './setup.js'

const POSIX = process.platform !== 'win32'

function check(report: { checks: SetupCheck[] }, id: string): SetupCheck {
  const c = report.checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id}`)
  return c
}

/** Fake fetch routing by URL substring. */
function fakeFetch(routes: Record<string, { ok: boolean; json?: unknown }>): FetchLike {
  return (async (url: string) => {
    for (const [frag, resp] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        return {
          ok: resp.ok,
          status: resp.ok ? 200 : 403,
          statusText: resp.ok ? 'OK' : 'Forbidden',
          json: async () => resp.json ?? {},
          text: async () => JSON.stringify(resp.json ?? {}),
        }
      }
    }
    throw new Error(`unrouted fetch: ${url}`)
  }) as unknown as FetchLike
}

describe('runSetup', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-setup-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('all-green when every probe succeeds', async () => {
    initSeed('demo', { cwd: work })
    const report = await runSetup({
      cwd: work,
      keychain: null,
      home: join(work, 'compost-home'),
      env: { HUGGINGFACE_TOKEN: 'hf_x' },
      ollamaUrl: 'http://ollama',
      transcriberUrl: 'http://tx',
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3:latest' }] } },
        '/health': { ok: true },
        'huggingface.co': { ok: true },
      }),
      exec: async () => ({ stdout: '27.0.0', ok: true }),
    })
    assert.equal(report.ready, true)
    assert.equal(check(report, 'ollama').status, 'ok')
    assert.equal(check(report, 'model:bge-m3').status, 'ok')
    assert.equal(check(report, 'docker').status, 'ok')
    assert.equal(check(report, 'transcriber').status, 'ok')
    assert.equal(check(report, 'hf-token').status, 'ok')
    assert.equal(check(report, 'pyannote:pyannote/segmentation-3.0').status, 'ok')
  })

  it('fails (ready=false) when Ollama is down — blocks the core loop', async () => {
    initSeed('demo', { cwd: work })
    const report = await runSetup({
      cwd: work,
      keychain: null,
      home: join(work, 'compost-home'),
      env: {},
      fetchImpl: (async (url: string) => {
        if (String(url).includes('/api/tags')) throw new Error('ECONNREFUSED')
        throw new Error(`unrouted: ${url}`)
      }) as unknown as FetchLike,
      exec: async () => ({ stdout: '', ok: false }),
    })
    assert.equal(report.ready, false)
    assert.equal(check(report, 'ollama').status, 'fail')
    assert.ok(check(report, 'ollama').fix?.includes('ollama'))
  })

  it('flags a missing required model as fail with an `ollama pull` fix', async () => {
    initSeed('demo', { cwd: work })
    const report = await runSetup({
      cwd: work,
      keychain: null,
      home: join(work, 'compost-home'),
      env: {},
      requiredOllamaModels: ['bge-m3'],
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'llama3.1:8b' }] } },
      }),
      exec: async () => ({ stdout: '', ok: false }),
    })
    assert.equal(check(report, 'model:bge-m3').status, 'fail')
    assert.equal(check(report, 'model:bge-m3').fix, 'ollama pull bge-m3')
    assert.equal(report.ready, false)
  })

  it('docker + transcriber down are warns (feature-gated), not fails', async () => {
    initSeed('demo', { cwd: work })
    const report = await runSetup({
      cwd: work,
      keychain: null,
      home: join(work, 'compost-home'),
      env: { HUGGINGFACE_TOKEN: 'hf_x' },
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3' }] } },
        // /health unrouted → throws → transcriber warn
        'huggingface.co': { ok: true },
      }),
      exec: async () => ({ stdout: '', ok: false }), // docker down
    })
    assert.equal(check(report, 'docker').status, 'warn')
    assert.equal(check(report, 'transcriber').status, 'warn')
    // No fails → ready stays true (core loop works without transcribe).
    assert.equal(report.ready, true)
  })

  it('pyannote license 403 is a warn with the accept URL (not a metadata ping)', async () => {
    initSeed('demo', { cwd: work })
    const report = await runSetup({
      cwd: work,
      keychain: null,
      home: join(work, 'compost-home'),
      env: { HUGGINGFACE_TOKEN: 'hf_x' },
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3' }] } },
        '/health': { ok: true },
        'speaker-diarization-3.1': { ok: true },
        'segmentation-3.0': { ok: false }, // license not accepted
      }),
      exec: async () => ({ stdout: '27', ok: true }),
    })
    const seg = check(report, 'pyannote:pyannote/segmentation-3.0')
    assert.equal(seg.status, 'warn')
    assert.match(seg.fix ?? '', /huggingface\.co\/pyannote\/segmentation-3\.0/)
  })

  it('resolves the HF token from a 0600 secrets.env (not just env)', async () => {
    initSeed('demo', { cwd: work })
    const home = join(work, 'compost-home')
    setSecret('HUGGINGFACE_TOKEN', 'hf_fromfile', { keychain: null, home })
    const report = await runSetup({
      cwd: work,
      env: {}, // not in env — must come from the file
      keychain: null,
      home,
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3' }] } },
        '/health': { ok: true },
        'huggingface.co': { ok: true },
      }),
      exec: async () => ({ stdout: '27', ok: true }),
    })
    const hf = check(report, 'hf-token')
    assert.equal(hf.status, 'ok')
    assert.match(hf.detail, /source: file/)
  })

  it('warns (non-blocking) on a world-readable secret file under ~/.compost', async () => {
    if (!POSIX) return
    initSeed('demo', { cwd: work })
    const home = join(work, 'compost-home')
    setSecret('HUGGINGFACE_TOKEN', 'hf_x', { keychain: null, home })
    chmodSync(secretsEnvPath({ home }), 0o644) // loosen perms
    const report = await runSetup({
      cwd: work,
      env: { HUGGINGFACE_TOKEN: 'hf_x' }, // env so hf-token stays ok
      keychain: null,
      home,
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3' }] } },
        '/health': { ok: true },
        'huggingface.co': { ok: true },
      }),
      exec: async () => ({ stdout: '27', ok: true }),
    })
    const perms = report.checks.find((c) => c.id.startsWith('secret-perms:'))
    assert.ok(perms, 'expected a secret-perms check')
    assert.equal(perms?.status, 'warn')
    assert.match(perms?.fix ?? '', /chmod 600/)
    assert.equal(report.ready, true) // warn is non-blocking
  })

  it('warns when no Seeds/ directory exists', async () => {
    const report = await runSetup({
      cwd: work, // no Seeds/ here
      keychain: null,
      home: join(work, 'compost-home'),
      env: { HUGGINGFACE_TOKEN: 'hf_x' },
      fetchImpl: fakeFetch({
        '/api/tags': { ok: true, json: { models: [{ name: 'bge-m3' }] } },
        '/health': { ok: true },
        'huggingface.co': { ok: true },
      }),
      exec: async () => ({ stdout: '27', ok: true }),
    })
    assert.equal(check(report, 'seeds').status, 'warn')
  })
})
