import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FetchLike } from './llm/types.js'
import { backoffSchedule } from './loops/supervisor.js'
import { TranscriberClient, TranscriberServiceError } from './transcriber_client.js'

function stub(status: number, json: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => json,
    text: async () => JSON.stringify(json),
  })
}

describe('TranscriberClient', () => {
  it('health reports ok from /health', async () => {
    const c = new TranscriberClient({
      fetchImpl: stub(200, { status: 'ok', versions: { x: '1' } }),
    })
    const h = await c.health()
    assert.equal(h.ok, true)
    assert.equal(h.versions.x, '1')
  })

  it('transcribe returns the response on 200', async () => {
    const c = new TranscriberClient({
      fetchImpl: stub(200, { session_id: 'S001', transcript_path: '/p.json', status: 'ok' }),
    })
    const r = await c.transcribe('/a.mp4', 'S001', '/seeds/demo')
    assert.equal(r.transcript_path, '/p.json')
  })

  it('throws model_missing on 503', async () => {
    const c = new TranscriberClient({ fetchImpl: stub(503, {}) })
    await assert.rejects(
      () => c.transcribe('/a.mp4', 'S001', '/seeds/demo'),
      (e: unknown) => {
        return e instanceof TranscriberServiceError && e.kind === 'model_missing'
      },
    )
  })

  it('throws down when fetch rejects', async () => {
    const c = new TranscriberClient({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await assert.rejects(
      () => c.transcribe('/a.mp4', 'S001', '/seeds/demo'),
      (e: unknown) => {
        return e instanceof TranscriberServiceError && e.kind === 'down'
      },
    )
  })
})

describe('backoffSchedule', () => {
  it('is exponential and capped at maxAttempts', () => {
    assert.deepEqual(backoffSchedule(3, 500), [500, 1000, 2000])
  })
})
