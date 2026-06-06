import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EventWriter } from '@they-juanreina/compost-provenance'

import { initSeed } from '../lib/seed.js'
import { saturationPulseOnce, suggestThemesOnce } from './synthesis.js'

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
