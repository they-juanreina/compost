import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isCompostError } from '../errors.js'
import { assertHighlightsEmbedded, countHighlightArtifacts } from './embeddedHighlights.js'

function seedWith(files: Record<string, string>): string {
  const seed = mkdtempSync(join(tmpdir(), 'compost-eh-'))
  mkdirSync(join(seed, 'highlights'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(seed, 'highlights', name), body, 'utf8')
  }
  return seed
}

describe('assertHighlightsEmbedded (dogfood 2026-07-01: silent embedding failure)', () => {
  it('is a no-op when there are no highlights yet (nothing to cluster)', () => {
    const seed = seedWith({})
    try {
      assert.doesNotThrow(() => assertHighlightsEmbedded(seed, []))
      assert.equal(countHighlightArtifacts(seed), 0)
    } finally {
      rmSync(seed, { recursive: true, force: true })
    }
  })

  it('throws an actionable error when highlights exist but none are embedded', () => {
    // The exact case from the call: highlights created, embed pass never ran →
    // `rescan` used to report a bland `suggested: 0`.
    const seed = seedWith({ 'H-001.md': '# h1', 'H-002.md': '# h2' })
    try {
      assert.throws(
        () => assertHighlightsEmbedded(seed, []),
        (err: unknown) =>
          isCompostError(err) &&
          err.code === 'INVALID_INPUT' &&
          /reindex --vectors/.test(err.message) &&
          /2 highlight/.test(err.message),
      )
    } finally {
      rmSync(seed, { recursive: true, force: true })
    }
  })

  it('throws when every embedding is degenerate (zero/NaN — provider failed)', () => {
    const seed = seedWith({ 'H-001.md': '# h1', 'H-002.md': '# h2' })
    try {
      assert.throws(
        () =>
          assertHighlightsEmbedded(seed, [
            { id: 'H-001', vector: [0, 0, 0] },
            { id: 'H-002', vector: [Number.NaN, 0, 0] },
          ]),
        (err: unknown) =>
          isCompostError(err) && err.code === 'INVALID_INPUT' && /degenerate/.test(err.message),
      )
    } finally {
      rmSync(seed, { recursive: true, force: true })
    }
  })

  it('passes when at least one healthy embedding is present', () => {
    const seed = seedWith({ 'H-001.md': '# h1', 'H-002.md': '# h2' })
    try {
      assert.doesNotThrow(() =>
        assertHighlightsEmbedded(seed, [
          { id: 'H-001', vector: [0, 0, 0] },
          { id: 'H-002', vector: [0.2, 0.9, 0.1] },
        ]),
      )
    } finally {
      rmSync(seed, { recursive: true, force: true })
    }
  })
})
