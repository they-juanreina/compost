import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clusterByEmbedding, saturationPulse, suggestCodeClusters } from './clustering.js'

describe('clusterByEmbedding', () => {
  it('groups near-parallel vectors and separates orthogonal ones', () => {
    const items = [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0.99, 0.01] },
      { id: 'c', vector: [0, 1] },
    ]
    const clusters = clusterByEmbedding(items, 0.9)
    // a,b cluster together; c separate
    const ab = clusters.find((cl) => cl.members.includes('a'))
    assert.deepEqual(ab?.members.sort(), ['a', 'b'])
    assert.ok(clusters.some((cl) => cl.members.length === 1 && cl.members[0] === 'c'))
  })

  it('reports cohesion in [0,1]', () => {
    const clusters = clusterByEmbedding([{ id: 'a', vector: [1, 0] }], 0.9)
    assert.equal(clusters[0]?.cohesion, 1)
  })
})

describe('suggestCodeClusters', () => {
  it('only returns clusters with >= minSize members', () => {
    const items = [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0.98, 0.02] },
      { id: 'c', vector: [0, 1] }, // singleton
    ]
    const out = suggestCodeClusters(items, { threshold: 0.9, minSize: 2 })
    assert.equal(out.length, 1)
    assert.equal(out[0]?.members.length, 2)
  })
})

describe('saturationPulse', () => {
  it('flags conclude when 2 consecutive sessions add no new themes', () => {
    const r = saturationPulse([
      { id: 'S1', themes: ['trust', 'verify'] },
      { id: 'S2', themes: ['trust'] }, // no new
      { id: 'S3', themes: ['verify'] }, // no new
    ])
    assert.equal(r.recommendation, 'conclude')
    assert.equal(r.per_session[1]?.novelty, 0)
    assert.equal(r.per_session[2]?.new_themes.length, 0)
  })

  it('recommends pause after a single dry session', () => {
    const r = saturationPulse([
      { id: 'S1', themes: ['a', 'b'] },
      { id: 'S2', themes: ['a'] }, // dry
    ])
    assert.equal(r.recommendation, 'pause')
  })

  it('recommends continue while novel themes keep appearing', () => {
    const r = saturationPulse([
      { id: 'S1', themes: ['a'] },
      { id: 'S2', themes: ['b'] },
      { id: 'S3', themes: ['c'] },
    ])
    assert.equal(r.recommendation, 'continue')
    assert.equal(r.per_session[2]?.novelty, 1)
  })
})
