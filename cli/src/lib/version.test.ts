import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FetchLike } from '../llm/types.js'
import { checkVersionStatus, compareVersions, currentCliVersion } from './version.js'

describe('compareVersions', () => {
  it('orders the release stream including prereleases', () => {
    assert.ok(compareVersions('0.1.0-rc.2', '0.1.0') < 0)
    assert.ok(compareVersions('0.1.0', '0.1.2') < 0)
    assert.ok(compareVersions('0.1.0-rc.2', '0.1.2') < 0) // the field-test case (#245)
    assert.ok(compareVersions('0.1.2', '0.1.2') === 0)
    assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
    assert.ok(compareVersions('1.0.0', '0.9.9') > 0)
    assert.ok(compareVersions('0.1.0-rc.1', '0.1.0-rc.2') < 0)
  })
})

describe('checkVersionStatus (#245)', () => {
  const fakeFetch = (resp: { ok: boolean; json?: unknown } | 'throw'): FetchLike =>
    (async () => {
      if (resp === 'throw') throw new Error('offline')
      return { ok: resp.ok, json: async () => resp.json ?? {} }
    }) as unknown as FetchLike

  it('reports behind when the registry has a newer latest', async () => {
    const status = await checkVersionStatus({
      fetchImpl: fakeFetch({ ok: true, json: { latest: '0.1.2' } }),
      current: '0.1.0-rc.2',
    })
    assert.deepEqual(status, { current: '0.1.0-rc.2', latest: '0.1.2', behind: true })
  })

  it('reports current when up to date', async () => {
    const status = await checkVersionStatus({
      fetchImpl: fakeFetch({ ok: true, json: { latest: '0.1.2' } }),
      current: '0.1.2',
    })
    assert.equal(status?.behind, false)
  })

  it('returns null (never throws) when offline or the registry misbehaves', async () => {
    assert.equal(await checkVersionStatus({ fetchImpl: fakeFetch('throw'), current: '1.0.0' }), null)
    assert.equal(
      await checkVersionStatus({ fetchImpl: fakeFetch({ ok: false }), current: '1.0.0' }),
      null,
    )
    assert.equal(
      await checkVersionStatus({ fetchImpl: fakeFetch({ ok: true, json: {} }), current: '1.0.0' }),
      null,
    )
  })

  it('currentCliVersion reads a real version from the package manifest', () => {
    assert.match(currentCliVersion(), /^\d+\.\d+\.\d+/)
  })
})
