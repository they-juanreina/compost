import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Coding,
  cohensKappaBinary,
  computeAgreement,
  krippendorffAlphaNominal,
} from './agreement.js'

function approx(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual !== null, 'expected a number, got null')
  assert.ok(Math.abs((actual as number) - expected) < eps, `expected ≈${expected}, got ${actual}`)
}

/**
 * Canonical 2×2 dataset (Wikipedia Cohen's κ example): n=50, both-yes=20,
 * A-yes/B-no=5, A-no/B-yes=10, both-no=15 → po=0.7, pe=0.5, κ=0.4.
 * The same coincidences give nominal α = 0.4 (hand-computed).
 */
function dataset2x2(): { a: boolean[]; b: boolean[] } {
  const a: boolean[] = []
  const b: boolean[] = []
  const push = (count: number, av: boolean, bv: boolean) => {
    for (let i = 0; i < count; i++) {
      a.push(av)
      b.push(bv)
    }
  }
  push(20, true, true)
  push(5, true, false)
  push(10, false, true)
  push(15, false, false)
  return { a, b }
}

describe('cohensKappaBinary', () => {
  it('perfect agreement → κ = 1', () => {
    const r = cohensKappaBinary([true, false, true, true], [true, false, true, true])
    assert.equal(r.kappa, 1)
  })

  it('canonical 2×2 example → κ = 0.4 (po=0.7, pe=0.5)', () => {
    const { a, b } = dataset2x2()
    const r = cohensKappaBinary(a, b)
    approx(r.po, 0.7)
    approx(r.pe, 0.5)
    approx(r.kappa, 0.4)
    assert.equal(r.n, 50)
  })

  it('no agreement beyond chance → κ ≈ 0', () => {
    // a all-true, b all-false: po=0, pe=0 → κ=0
    const r = cohensKappaBinary([true, true, true], [false, false, false])
    approx(r.kappa, 0)
  })

  it('both coders mark every cell the same → degenerate, κ = 1', () => {
    const r = cohensKappaBinary([true, true], [true, true])
    assert.equal(r.kappa, 1)
  })

  it('empty input → null', () => {
    assert.equal(cohensKappaBinary([], []).kappa, null)
  })
})

describe('krippendorffAlphaNominal', () => {
  it('perfect agreement → α = 1', () => {
    assert.equal(
      krippendorffAlphaNominal([
        ['a', 'a'],
        ['b', 'b'],
        ['a', 'a'],
      ]),
      1,
    )
  })

  it('canonical 2×2 coincidences → α = 0.4', () => {
    const units: Array<Array<string | null>> = []
    const push = (count: number, av: string, bv: string) => {
      for (let i = 0; i < count; i++) units.push([av, bv])
    }
    push(20, 'present', 'present')
    push(5, 'present', 'absent')
    push(10, 'absent', 'present')
    push(15, 'absent', 'absent')
    approx(krippendorffAlphaNominal(units), 0.4)
  })

  it('units with fewer than two values are dropped → null when none pairable', () => {
    assert.equal(krippendorffAlphaNominal([['a', null], [null, 'b']]), null)
  })
})

describe('computeAgreement', () => {
  function codings(): Coding[] {
    // 12 doubly-coded highlights, 2 codes, mostly-agreeing machine vs human.
    const out: Coding[] = []
    for (let i = 1; i <= 12; i++) {
      const u = `H-${String(i).padStart(3, '0')}`
      // both apply 'distrust' to the first 8
      if (i <= 8) {
        out.push({ coder: 'human', unit: u, code: 'distrust' })
        out.push({ coder: 'machine', unit: u, code: 'distrust' })
      }
      // human applies 'override' to 9-12; machine only to 9-10 (two misses)
      if (i >= 9) {
        out.push({ coder: 'human', unit: u, code: 'override' })
        if (i <= 10) out.push({ coder: 'machine', unit: u, code: 'override' })
        else out.push({ coder: 'machine', unit: u, code: 'distrust' }) // keep it doubly-coded
      }
    }
    return out
  }

  it('reports κ over the doubly-coded set', () => {
    const r = computeAgreement(codings(), { minUnits: 10 })
    assert.equal(r.status, 'ok')
    assert.equal(r.doubly_coded_units, 12)
    assert.equal(r.codes, 2)
    assert.ok(r.pooled_kappa !== null && r.pooled_kappa > 0)
    assert.ok(['fair', 'moderate', 'substantial', 'almost perfect'].includes(r.interpretation))
    assert.equal(r.per_code.length, 2)
  })

  it('reports insufficient below minUnits (κ on few items is noise)', () => {
    const few: Coding[] = [
      { coder: 'human', unit: 'H-001', code: 'x' },
      { coder: 'machine', unit: 'H-001', code: 'x' },
    ]
    const r = computeAgreement(few, { minUnits: 10 })
    assert.equal(r.status, 'insufficient')
    assert.equal(r.pooled_kappa, null)
    assert.match(r.note ?? '', /recode --blind/)
  })

  it('passes through the excluded unnamed-cluster count (no silent caps)', () => {
    const r = computeAgreement(codings(), { minUnits: 10, excludedUnnamedMachineCodes: 3 })
    assert.equal(r.excluded_unnamed_machine_codes, 3)
  })

  it('only units coded by BOTH coders count', () => {
    const mixed: Coding[] = [
      { coder: 'human', unit: 'H-001', code: 'x' }, // human-only → excluded
      { coder: 'machine', unit: 'H-002', code: 'x' }, // machine-only → excluded
    ]
    const r = computeAgreement(mixed, { minUnits: 1 })
    assert.equal(r.doubly_coded_units, 0)
  })
})
