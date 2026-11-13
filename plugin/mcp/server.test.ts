import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createServer, toolListing } from './server.js'
import { PLUGIN_VERSION, TOOLS } from './tools.js'

describe('toolListing annotations', () => {
  const listing = toolListing(TOOLS)
  const byName = (n: string) => {
    const found = listing.find((t) => t.name === n)
    assert.ok(found, `missing tool ${n}`)
    return found
  }

  it('marks every readOnly tool readOnlyHint: true', () => {
    for (const t of TOOLS.filter((x) => x.readOnly)) {
      assert.equal(byName(t.name).annotations.readOnlyHint, true, t.name)
    }
    for (const n of ['compost_status', 'compost_blame', 'compost_list']) {
      assert.equal(byName(n).annotations.readOnlyHint, true, n)
    }
  })

  it('does not mark mutations readOnly', () => {
    const muts = TOOLS.filter(
      (t) =>
        t.name === 'compost_endorse' ||
        t.name === 'compost_reject' ||
        t.name.startsWith('compost_create_'),
    )
    assert.ok(muts.length >= 6)
    for (const t of muts) {
      const a = byName(t.name).annotations as Record<string, unknown>
      assert.equal(a.readOnlyHint, false, t.name)
      assert.ok(!('destructiveHint' in a), t.name)
    }
  })
})

describe('server identity', () => {
  it('reports PLUGIN_VERSION', () => {
    const info = (createServer() as unknown as { _serverInfo: { version: string } })._serverInfo
    assert.equal(info.version, PLUGIN_VERSION)
  })
})
