import { existsSync } from 'node:fs'

import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'

/**
 * Human↔machine intercoder agreement (§4).
 *
 * compost's *native* workflow produces endorse/reject decisions, which are
 * reactive (the human sees the AI code first) — a κ computed on that violates κ's
 * independence assumption. So legitimate agreement requires INDEPENDENT double
 * coding: a researcher codes a sampled highlight set against the shared codebook
 * WITHOUT seeing the machine's codes (`compost recode --blind`), and we compare
 * those blind human codings to the machine codings on the doubly-coded units.
 *
 * A unit (highlight) can carry multiple codes, so we model each (unit, code) as a
 * binary present/absent decision and compute, over the doubly-coded set:
 *  - Cohen's κ per code and pooled over all (unit, code) cells (2 coders),
 *  - Krippendorff's nominal α over the pooled cells (cross-check; handles the
 *    general case).
 */

export type Coder = 'human' | 'machine'

/** One coder asserting one code applies to one unit (highlight). */
export interface Coding {
  coder: Coder
  unit: string
  code: string
}

export interface KappaResult {
  kappa: number | null // null when undefined (one coder marked every cell the same → pe=1)
  po: number
  pe: number
  n: number
}

export interface PerCodeAgreement {
  code: string
  kappa: number | null
  support: number // doubly-coded units where either coder applied this code
}

export interface AgreementReport {
  status: 'ok' | 'insufficient'
  doubly_coded_units: number
  codes: number
  per_code: PerCodeAgreement[]
  pooled_kappa: number | null
  krippendorff_alpha: number | null
  interpretation: string // Landis & Koch band for the pooled κ
  excluded_unnamed_machine_codes: number // unsupervised clusters have no shared label
  note?: string
}

// ---------------------------------------------------------------- κ (binary)

/** Cohen's κ for a single binary variable across paired ratings. */
export function cohensKappaBinary(a: boolean[], b: boolean[]): KappaResult {
  if (a.length !== b.length) throw new Error('cohensKappaBinary: rating arrays differ in length')
  const n = a.length
  if (n === 0) return { kappa: null, po: 0, pe: 0, n: 0 }
  let n11 = 0
  let n00 = 0
  let aTrue = 0
  let bTrue = 0
  for (let i = 0; i < n; i++) {
    if (a[i]) aTrue++
    if (b[i]) bTrue++
    if (a[i] && b[i]) n11++
    if (!a[i] && !b[i]) n00++
  }
  const po = (n11 + n00) / n
  const pYesA = aTrue / n
  const pYesB = bTrue / n
  const pe = pYesA * pYesB + (1 - pYesA) * (1 - pYesB)
  if (1 - pe === 0) {
    // Degenerate: both marginals saturated. κ is conventionally 1 iff perfect.
    return { kappa: po === 1 ? 1 : 0, po, pe, n }
  }
  return { kappa: (po - pe) / (1 - pe), po, pe, n }
}

// ------------------------------------------------- Krippendorff α (nominal)

/**
 * Krippendorff's α (nominal metric) over a units × coders matrix. Cells may be
 * null (a coder didn't code that unit). Units with fewer than two values are
 * dropped (not pairable). General coincidence-matrix algorithm.
 */
export function krippendorffAlphaNominal(units: Array<Array<string | null>>): number | null {
  // Coincidence matrix o[c][k] and value marginals.
  const o = new Map<string, Map<string, number>>()
  const bump = (c: string, k: string, by: number) => {
    if (!o.has(c)) o.set(c, new Map())
    const row = o.get(c) as Map<string, number>
    row.set(k, (row.get(k) ?? 0) + by)
  }
  for (const unit of units) {
    const vals = unit.filter((v): v is string => v !== null)
    const m = vals.length
    if (m < 2) continue
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        if (i === j) continue
        bump(vals[i] as string, vals[j] as string, 1 / (m - 1))
      }
    }
  }
  const values = [...o.keys()]
  let n = 0
  const marginal = new Map<string, number>()
  for (const c of values) {
    let rowSum = 0
    for (const k of values) rowSum += o.get(c)?.get(k) ?? 0
    marginal.set(c, rowSum)
    n += rowSum
  }
  if (n < 2) return null
  // Observed disagreement (nominal δ = 1 when c≠k).
  let Do = 0
  for (const c of values) {
    for (const k of values) {
      if (c === k) continue
      Do += o.get(c)?.get(k) ?? 0
    }
  }
  Do /= n
  // Expected disagreement.
  let De = 0
  for (const c of values) {
    for (const k of values) {
      if (c === k) continue
      De += (marginal.get(c) as number) * (marginal.get(k) as number)
    }
  }
  De /= n * (n - 1)
  if (De === 0) return Do === 0 ? 1 : 0
  return 1 - Do / De
}

// ------------------------------------------------------- agreement over codings

function landisKoch(k: number | null): string {
  if (k === null) return 'undefined'
  if (k < 0) return 'poor (worse than chance)'
  if (k <= 0.2) return 'slight'
  if (k <= 0.4) return 'fair'
  if (k <= 0.6) return 'moderate'
  if (k <= 0.8) return 'substantial'
  return 'almost perfect'
}

export interface AgreementOptions {
  /** Minimum doubly-coded units below which κ is statistical noise. */
  minUnits?: number
  excludedUnnamedMachineCodes?: number
}

/**
 * Compute agreement from a flat list of (coder, unit, code) codings. Only units
 * coded by BOTH coders count (the doubly-coded set); the codebook is the union of
 * codes either coder used on those units.
 */
export function computeAgreement(codings: Coding[], opts: AgreementOptions = {}): AgreementReport {
  const minUnits = opts.minUnits ?? 10
  const excluded = opts.excludedUnnamedMachineCodes ?? 0

  const byCoderUnit: Record<Coder, Map<string, Set<string>>> = {
    human: new Map(),
    machine: new Map(),
  }
  const allCodes = new Set<string>()
  for (const { coder, unit, code } of codings) {
    if (!byCoderUnit[coder].has(unit)) byCoderUnit[coder].set(unit, new Set())
    byCoderUnit[coder].get(unit)?.add(code)
    allCodes.add(code)
  }

  const doublyCoded = [...byCoderUnit.human.keys()]
    .filter((u) => byCoderUnit.machine.has(u))
    .sort()
  const codes = [...allCodes].sort()

  const base = {
    doubly_coded_units: doublyCoded.length,
    codes: codes.length,
    excluded_unnamed_machine_codes: excluded,
  }

  if (doublyCoded.length < minUnits) {
    return {
      status: 'insufficient',
      ...base,
      per_code: [],
      pooled_kappa: null,
      krippendorff_alpha: null,
      interpretation: 'undefined',
      note: `Only ${doublyCoded.length} doubly-coded unit(s); need ≥ ${minUnits} for a meaningful κ. Code more highlights with \`compost recode --blind\`.`,
    }
  }

  const has = (coder: Coder, unit: string, code: string): boolean =>
    byCoderUnit[coder].get(unit)?.has(code) ?? false

  // Per-code binary κ.
  const perCode: PerCodeAgreement[] = []
  for (const code of codes) {
    const a: boolean[] = []
    const b: boolean[] = []
    let support = 0
    for (const u of doublyCoded) {
      const h = has('human', u, code)
      const m = has('machine', u, code)
      a.push(h)
      b.push(m)
      if (h || m) support++
    }
    perCode.push({ code, kappa: cohensKappaBinary(a, b).kappa, support })
  }

  // Pooled κ over every (unit, code) cell, and α as a cross-check on the same cells.
  const pooledA: boolean[] = []
  const pooledB: boolean[] = []
  const alphaUnits: Array<Array<string | null>> = []
  for (const u of doublyCoded) {
    for (const code of codes) {
      const h = has('human', u, code)
      const m = has('machine', u, code)
      pooledA.push(h)
      pooledB.push(m)
      alphaUnits.push([h ? 'present' : 'absent', m ? 'present' : 'absent'])
    }
  }
  const pooled = cohensKappaBinary(pooledA, pooledB).kappa

  return {
    status: 'ok',
    ...base,
    per_code: perCode,
    pooled_kappa: pooled,
    krippendorff_alpha: krippendorffAlphaNominal(alphaUnits),
    interpretation: landisKoch(pooled),
  }
}

// ------------------------------------------------------- read codings from log

interface CreateRow {
  artifact_id: string
  actor_type: string
  payload: string
}

/**
 * Extract codings from a seed's event log. Machine codings come from named `code`
 * create events (actor ai/agent) via their `evidence` highlight ids; unnamed
 * cluster codes (similarity-scanner `members`) have no shared label and are
 * excluded (counted, never silently dropped). Human codings come from blind
 * `coding` link events (actor researcher, payload.blind === true). Artifacts with
 * a reject/unlink event are excluded.
 */
export function readCodings(eventsDbPath: string): {
  codings: Coding[]
  excludedUnnamedMachineCodes: number
} {
  if (!existsSync(eventsDbPath)) {
    throw new CompostError('FILE_NOT_FOUND', `No events.sqlite at ${eventsDbPath}`)
  }
  const db = new Database(eventsDbPath, { readonly: true, fileMustExist: true })
  try {
    const archived = new Set(
      (
        db
          .prepare("SELECT DISTINCT artifact_id FROM events WHERE action IN ('reject','unlink')")
          .all() as Array<{ artifact_id: string }>
      ).map((r) => r.artifact_id),
    )

    const codings: Coding[] = []
    let excludedUnnamed = 0

    const machineRows = db
      .prepare(
        "SELECT artifact_id, actor_type, payload FROM events WHERE action='create' AND artifact_kind='code' AND actor_type IN ('ai','agent')",
      )
      .all() as CreateRow[]
    for (const row of machineRows) {
      if (archived.has(row.artifact_id)) continue
      const p = safeParse(row.payload)
      const code = typeof p.name === 'string' ? p.name : undefined
      const units = (p.evidence ?? p.members) as unknown
      if (code === undefined) {
        if (Array.isArray(units) && units.length > 0) excludedUnnamed++
        continue
      }
      if (!Array.isArray(units)) continue
      for (const u of units) {
        if (typeof u === 'string') codings.push({ coder: 'machine', unit: u, code })
      }
    }

    const humanRows = db
      .prepare(
        "SELECT artifact_id, actor_type, payload FROM events WHERE action='link' AND artifact_kind='coding' AND actor_type='researcher'",
      )
      .all() as CreateRow[]
    for (const row of humanRows) {
      if (archived.has(row.artifact_id)) continue
      const p = safeParse(row.payload)
      if (p.blind !== true) continue
      if (typeof p.code === 'string' && typeof p.highlight === 'string') {
        codings.push({ coder: 'human', unit: p.highlight, code: p.code })
      }
    }

    return { codings, excludedUnnamedMachineCodes: excludedUnnamed }
  } finally {
    db.close()
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
