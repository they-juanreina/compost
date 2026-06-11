import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { diffLines, parseVersions } from './journal.js'

describe('parseVersions', () => {
  it('separates the working draft from versioned sections', () => {
    const content = [
      'current prompt',
      '',
      '<!-- compost:version 2026-06-01T00:00:00Z -->',
      'old prompt',
    ].join('\n')
    const { draft, versions } = parseVersions(content)
    assert.equal(draft, 'current prompt')
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.ts, '2026-06-01T00:00:00Z')
    assert.equal(versions[0]?.body, 'old prompt')
  })

  it('treats a marker-less file as all draft', () => {
    const { draft, versions } = parseVersions('just a prompt')
    assert.equal(draft, 'just a prompt')
    assert.equal(versions.length, 0)
  })
})

describe('diffLines', () => {
  it('marks added, deleted, and context lines', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    assert.deepEqual(
      diff.map((d) => `${d.type}:${d.text}`),
      ['ctx:a', 'del:b', 'add:B', 'ctx:c'],
    )
  })

  it('handles pure additions', () => {
    const diff = diffLines('a', 'a\nb')
    assert.deepEqual(diff, [
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
    ])
  })
})
