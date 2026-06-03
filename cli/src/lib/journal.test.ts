import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { appendVersion, diffLines, parseVersions } from './journal.js'

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

describe('appendVersion', () => {
  it('records the current draft as a timestamped version', () => {
    const out = appendVersion('my prompt', '2026-06-03T00:00:00Z')
    const { versions } = parseVersions(out)
    assert.equal(versions.length, 1)
    assert.equal(versions[0]?.ts, '2026-06-03T00:00:00Z')
    assert.match(versions[0]?.body ?? '', /my prompt/)
  })

  it('is a no-op on an empty draft', () => {
    assert.equal(appendVersion('   ', '2026-06-03T00:00:00Z'), '   ')
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
