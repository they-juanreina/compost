import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { computeAgreement, readCodings } from './agreement.js'
import { createCode } from './artifacts.js'
import { emitAgentCreate, openSeedEvents } from './events.js'
import { blindRecode } from './recode.js'

const HASH = 'a'.repeat(64)
const H = (n: number) => `H-${String(n).padStart(3, '0')}`

function aiAuthor() {
  return { actorType: 'ai' as const, actorId: 'claude-code:0.1.0:ab', model: 'm', promptHash: HASH }
}

describe('agreement over the event log (recode + machine codes)', () => {
  let seed: string
  beforeEach(() => {
    seed = mkdtempSync(join(tmpdir(), 'compost-agreement-'))
  })
  afterEach(() => {
    rmSync(seed, { recursive: true, force: true })
  })

  function eventsDb(): string {
    return join(seed, '.compost', 'events.sqlite')
  }

  it('computes κ over highlights coded by both machine and blind researcher', () => {
    const all = Array.from({ length: 12 }, (_, i) => H(i + 1))
    // Machine: 'distrust' on all 12; 'override' on 1–6.
    createCode(seed, { name: 'distrust', definition: 'd', evidence: all, author: aiAuthor() })
    createCode(seed, {
      name: 'override',
      definition: 'o',
      evidence: all.slice(0, 6),
      author: aiAuthor(),
    })
    // Human (blind): 'distrust' on all 12; 'override' on 1–8 (2 more than the machine).
    const overrideHuman: Record<string, string[]> = {}
    for (let i = 1; i <= 12; i++) overrideHuman[H(i)] = i <= 8 ? ['distrust', 'override'] : ['distrust']
    blindRecode(seed, { assignments: overrideHuman, researcherId: 'juan@x' })

    const { codings, excludedUnnamedMachineCodes } = readCodings(eventsDb())
    const report = computeAgreement(codings, { minUnits: 10, excludedUnnamedMachineCodes })

    assert.equal(report.status, 'ok')
    assert.equal(report.doubly_coded_units, 12)
    assert.equal(report.codes, 2)
    assert.ok(report.pooled_kappa !== null)
    const override = report.per_code.find((p) => p.code === 'override')
    assert.ok(override)
    // override: machine on 1–6, human on 1–8 → 2 disagreements out of 12, κ < 1.
    assert.ok((override?.kappa ?? 1) < 1)
  })

  it('excludes unnamed cluster codes (counted, not silently dropped)', () => {
    const all = Array.from({ length: 10 }, (_, i) => H(i + 1))
    createCode(seed, { name: 'distrust', definition: 'd', evidence: all, author: aiAuthor() })
    // An unsupervised cluster: members, no shared name.
    const w = openSeedEvents(seed)
    emitAgentCreate(w, {
      artifactKind: 'code',
      initialState: { kind: 'code', members: [H(1), H(2)], cohesion: 0.9 },
      agentName: 'similarity-scanner',
      agentVersion: '0.1.0',
    })
    w.close()

    const { codings, excludedUnnamedMachineCodes } = readCodings(eventsDb())
    assert.equal(excludedUnnamedMachineCodes, 1)
    // the named 'distrust' codings are still present
    assert.ok(codings.some((c) => c.coder === 'machine' && c.code === 'distrust'))
    assert.ok(!codings.some((c) => c.code.startsWith('cluster')))
  })

  it('reports insufficient when too few units are doubly coded', () => {
    createCode(seed, { name: 'x', definition: 'x', evidence: [H(1)], author: aiAuthor() })
    blindRecode(seed, { assignments: { [H(1)]: ['x'] }, researcherId: 'juan@x' })
    const { codings } = readCodings(eventsDb())
    const report = computeAgreement(codings, { minUnits: 10 })
    assert.equal(report.status, 'insufficient')
    assert.equal(report.doubly_coded_units, 1)
  })
})
