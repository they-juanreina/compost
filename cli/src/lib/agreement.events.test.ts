import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { computeAgreement, computeAgreementForFrame, readCodings } from './agreement.js'
import { createCode, createCodebook } from './artifacts.js'
import { artifactId, emitAgentCreate, emitCreate, openSeedEvents } from './events.js'
import { blindRecode } from './recode.js'

const HASH = 'a'.repeat(64)
const H = (n: number) => `H-${String(n).padStart(3, '0')}`

function aiAuthor() {
  return { actorType: 'ai' as const, actorId: 'claude-code:0.1.0:ab', model: 'm', promptHash: HASH }
}

function researcher() {
  return { actorType: 'researcher' as const, actorId: 'juan@x' }
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
    for (let i = 1; i <= 12; i++)
      overrideHuman[H(i)] = i <= 8 ? ['distrust', 'override'] : ['distrust']
    blindRecode(seed, {
      assignments: overrideHuman,
      researcherId: 'juan@x',
      codebookId: 'CB-primary',
    })

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
    // Excluded count is keyed by codebook now; the cluster has no codebook_id → primary.
    assert.equal(excludedUnnamedMachineCodes['CB-primary'], 1)
    // the named 'distrust' codings are still present
    assert.ok(codings.some((c) => c.coder === 'machine' && c.code === 'distrust'))
    assert.ok(!codings.some((c) => c.code.startsWith('cluster')))
  })

  it('reports insufficient when too few units are doubly coded', () => {
    createCode(seed, { name: 'x', definition: 'x', evidence: [H(1)], author: aiAuthor() })
    blindRecode(seed, {
      assignments: { [H(1)]: ['x'] },
      researcherId: 'juan@x',
      codebookId: 'CB-primary',
    })
    const { codings } = readCodings(eventsDb())
    const report = computeAgreement(codings, { minUnits: 10 })
    assert.equal(report.status, 'insufficient')
    assert.equal(report.doubly_coded_units, 1)
  })

  it('readCodings tags each coding with its codebook (machine from code, human from recode)', () => {
    createCodebook(seed, { name: 'epistemology', stance: 'framework', author: researcher() })
    // Machine code in the epistemology frame; another in primary (default).
    createCode(seed, {
      name: 'situated',
      definition: 's',
      evidence: [H(1)],
      codebookId: 'epistemology',
      author: aiAuthor(),
    })
    createCode(seed, { name: 'distrust', definition: 'd', evidence: [H(2)], author: aiAuthor() })
    blindRecode(seed, {
      assignments: { [H(1)]: ['situated'] },
      researcherId: 'juan@x',
      codebookId: 'CB-epistemology',
    })
    blindRecode(seed, {
      assignments: { [H(2)]: ['distrust'] },
      researcherId: 'juan@x',
      codebookId: 'CB-primary',
    })

    const { codings } = readCodings(eventsDb())
    const epi = codings.filter((c) => c.codebook === 'CB-epistemology')
    const prim = codings.filter((c) => c.codebook === 'CB-primary')
    // 'situated' (machine + human) lands in epistemology; 'distrust' in primary.
    assert.ok(epi.every((c) => c.code === 'situated'))
    assert.ok(prim.every((c) => c.code === 'distrust'))
    assert.ok(epi.some((c) => c.coder === 'machine') && epi.some((c) => c.coder === 'human'))
  })

  it('scopes agreement within a frame — lenses are never pooled', () => {
    // Names slug to lowercase ids: lensa → CB-lensa, lensb → CB-lensb.
    createCodebook(seed, { name: 'lensa', stance: 'framework', author: researcher() })
    createCodebook(seed, { name: 'lensb', stance: 'framework', author: researcher() })
    const all = Array.from({ length: 12 }, (_, i) => H(i + 1))
    // Full double-coding in lensa; machine-only-vs-human-only (disjoint) in lensb.
    createCode(seed, {
      name: 'a',
      definition: 'a',
      evidence: all,
      codebookId: 'lensa',
      author: aiAuthor(),
    })
    createCode(seed, {
      name: 'b',
      definition: 'b',
      evidence: all.slice(0, 6),
      codebookId: 'lensb',
      author: aiAuthor(),
    })
    blindRecode(seed, {
      assignments: Object.fromEntries(all.map((h) => [h, ['a']])),
      researcherId: 'juan@x',
      codebookId: 'CB-lensa',
    })
    blindRecode(seed, {
      assignments: Object.fromEntries(all.slice(6).map((h) => [h, ['b']])),
      researcherId: 'juan@x',
      codebookId: 'CB-lensb',
    })

    const { codings, excludedUnnamedMachineCodes } = readCodings(eventsDb())
    // Drive the REAL scoping path (computeAgreementForFrame), not an inline
    // filter — so a dropped filter fails this test instead of silently pooling.
    // lensa: machine + human both cover all 12 → 12 doubly-coded units.
    const a = computeAgreementForFrame(codings, excludedUnnamedMachineCodes, 'CB-lensa', {
      minUnits: 10,
    })
    assert.equal(a.status, 'ok')
    assert.equal(a.doubly_coded_units, 12)
    // lensb: machine coded 1–6, human 7–12 → ZERO doubly-coded units in-frame.
    // If frames were pooled, lensb's units would mix with lensa's — they don't.
    const b = computeAgreementForFrame(codings, excludedUnnamedMachineCodes, 'CB-lensb', {
      minUnits: 10,
    })
    assert.equal(b.status, 'insufficient')
    assert.equal(b.doubly_coded_units, 0)
  })

  it('legacy codes/codings with no codebook in payload read back as CB-primary (#264)', () => {
    // Pre-codebook shapes: a machine code with NO codebook_id, and a blind
    // coding link with NO codebook key — both must fall back to CB-primary.
    const w = openSeedEvents(seed)
    emitCreate(w, {
      artifactKind: 'code',
      initialState: { id: 'C-legacy', kind: 'code', name: 'legacy', evidence: [H(1)] },
      author: { actorType: 'ai', actorId: 'x', model: 'm', promptHash: HASH },
    })
    w.appendBatch(
      [
        {
          artifact_kind: 'coding',
          artifact_id: artifactId({ coder: 'researcher-blind', highlight: H(1), code: 'legacy' }),
          action: 'link',
          actor_type: 'researcher',
          actor_id: 'juan@x',
          payload: { code: 'legacy', highlight: H(1), blind: true }, // no codebook key
        },
      ],
      'legacy-batch',
    )
    w.close()

    const { codings } = readCodings(eventsDb())
    const legacy = codings.filter((c) => c.code === 'legacy')
    assert.ok(legacy.length >= 2)
    assert.ok(legacy.every((c) => c.codebook === 'CB-primary'))
    assert.ok(legacy.some((c) => c.coder === 'machine') && legacy.some((c) => c.coder === 'human'))
  })
})
