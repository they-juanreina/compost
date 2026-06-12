import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EventWriter } from '@they-juanreina/compost-provenance'

import { listArtifacts } from '../lib/reads.js'
import { initSeed } from '../lib/seed.js'
import {
  type CodeForCategorizing,
  saturationPulseOnce,
  suggestCategoriesOnce,
  suggestThemesOnce,
} from './synthesis.js'

function eventsDb(path: string): string {
  return join(path, '.compost', 'events.sqlite')
}

describe('suggestThemesOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-synth-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('emits an AI code suggestion per cohesive cluster', () => {
    const { path } = initSeed('demo', { cwd: work })
    const highlights = [
      { id: 'H-1', vector: [1, 0] },
      { id: 'H-2', vector: [0.98, 0.02] },
      { id: 'H-3', vector: [0, 1] }, // singleton, excluded
    ]
    const out = suggestThemesOnce(path, highlights, { threshold: 0.9, minSize: 2 })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]?.members.sort(), ['H-1', 'H-2'])

    const ev = new EventWriter({ dbPath: eventsDb(path) })
    // @ts-expect-error private db for assertion
    const rows = ev.db
      .prepare("SELECT * FROM events WHERE actor_type='agent' AND agent_name='similarity-scanner'")
      .all()
    assert.equal(rows.length, 1)
    ev.close()
  })

  it('throttles to 20 suggestions per run', () => {
    const { path } = initSeed('demo', { cwd: work })
    // 25 mutually-similar-enough-to-be-singletons highlights (orthogonal pairs)
    const highlights = Array.from({ length: 50 }, (_, i) => ({
      id: `H-${i}`,
      // make 25 tight pairs
      vector: [Math.cos(Math.floor(i / 2)), Math.sin(Math.floor(i / 2))],
    }))
    const out = suggestThemesOnce(path, highlights, { threshold: 0.999, minSize: 2 })
    assert.ok(out.length <= 20)
  })
})

describe('saturationPulseOnce', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-pulse-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('emits an insight event and flags notify on conclude', () => {
    const { path } = initSeed('demo', { cwd: work })
    const result = saturationPulseOnce(path, [
      { id: 'S1', themes: ['a', 'b'] },
      { id: 'S2', themes: ['a'] },
      { id: 'S3', themes: ['b'] },
    ])
    assert.equal(result.recommendation, 'conclude')
    assert.equal(result.notify, true)
    assert.ok(existsSync(eventsDb(path)))
  })

  it('does not flag notify while themes keep emerging', () => {
    const { path } = initSeed('demo', { cwd: work })
    const result = saturationPulseOnce(path, [
      { id: 'S1', themes: ['a'] },
      { id: 'S2', themes: ['b'] },
    ])
    assert.equal(result.recommendation, 'continue')
    assert.equal(result.notify, false)
  })
})

describe('suggestCategoriesOnce (#267)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-cat-synth-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  // Two codes whose evidence centroids are near each other, one far away.
  const codes: CodeForCategorizing[] = [
    { id: 'C-a', evidence: ['H-1', 'H-2'], codebook_id: 'CB-primary' },
    { id: 'C-b', evidence: ['H-3'], codebook_id: 'CB-primary' },
    { id: 'C-far', evidence: ['H-4'], codebook_id: 'CB-primary' },
  ]
  const vecs = new Map<string, number[]>([
    ['H-1', [1, 0]],
    ['H-2', [0.99, 0.01]], // C-a centroid ≈ [0.995, 0.005]
    ['H-3', [0.98, 0.02]], // C-b ≈ [0.98, 0.02] — close to C-a
    ['H-4', [0, 1]], // C-far — orthogonal
  ])

  it('clusters code centroids into a category draft (cohesive codes only)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const out = suggestCategoriesOnce(path, codes, vecs, { threshold: 0.9, minSize: 2 })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0]?.members.sort(), ['C-a', 'C-b'])
    assert.equal(out[0]?.codebook_id, 'CB-primary')

    // Landed as a [draft] category in the event log, carrying its member codes.
    const cats = listArtifacts(path, 'category', { includeArchived: true })
    assert.equal(cats.length, 1)
    const state = cats[0]?.current_state as { status?: string; members?: string[] }
    assert.equal(state.status, 'draft')
    assert.deepEqual(state.members?.sort(), ['C-a', 'C-b'])
  })

  it('clusters WITHIN a codebook — codes in different frames never co-categorize', () => {
    const { path } = initSeed('demo', { cwd: work })
    const split: CodeForCategorizing[] = [
      { id: 'C-a', evidence: ['H-1'], codebook_id: 'CB-epistemology' },
      { id: 'C-b', evidence: ['H-3'], codebook_id: 'CB-justice' }, // same vector region, different frame
    ]
    const out = suggestCategoriesOnce(path, split, vecs, { threshold: 0.9, minSize: 2 })
    assert.equal(out.length, 0) // each frame has only 1 code → no cluster of ≥2
  })

  it('skips codes with no embedded evidence', () => {
    const { path } = initSeed('demo', { cwd: work })
    const noVecs: CodeForCategorizing[] = [
      { id: 'C-a', evidence: ['H-missing'], codebook_id: 'CB-primary' },
      { id: 'C-b', evidence: ['H-also-missing'], codebook_id: 'CB-primary' },
    ]
    const out = suggestCategoriesOnce(path, noVecs, vecs, { threshold: 0.9, minSize: 2 })
    assert.equal(out.length, 0)
  })

  it('throttles to MAX_SUGGESTIONS globally, not per codebook', () => {
    const { path } = initSeed('demo', { cwd: work })
    // 25 single-code "clusters" each its own pair, spread across 5 codebooks —
    // would be 25 if per-codebook-uncapped; the global cap holds it to 20.
    const many: CodeForCategorizing[] = []
    const v = new Map<string, number[]>()
    let h = 0
    for (let cb = 0; cb < 5; cb++) {
      for (let k = 0; k < 5; k++) {
        // two near-identical codes per (cb,k) → a cohesive 2-code cluster.
        for (const tag of ['x', 'y']) {
          const hid = `H-${h++}`
          v.set(hid, [1, k / 100]) // distinct per k so clusters don't merge across k
          many.push({ id: `C-${cb}-${k}-${tag}`, evidence: [hid], codebook_id: `CB-${cb}` })
        }
      }
    }
    const out = suggestCategoriesOnce(path, many, v, { threshold: 0.999, minSize: 2 })
    assert.ok(out.length <= 20, `expected <= 20 globally, got ${out.length}`)
  })
})
