import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchWithTimeout } from './http.js'
import type { FetchLike } from './types.js'

describe('fetchWithTimeout', () => {
  it('returns the response when the fetch resolves before the timeout', async () => {
    const ok: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ hi: true }),
      text: async () => '{}',
    })
    const res = await fetchWithTimeout(ok, 'http://x', { method: 'GET' }, 1000)
    assert.equal(res.ok, true)
  })

  it('aborts and rejects when the fetch outlives the timeout', async () => {
    // A fetch that only ever settles when its abort signal fires — i.e. a hang.
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    await assert.rejects(() => fetchWithTimeout(hanging, 'http://x', { method: 'GET' }, 10))
  })
})
