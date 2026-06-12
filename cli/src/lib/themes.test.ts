import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCategory, createCode, createCodebook, createTheme } from './artifacts.js'
import { linkCodeToCategory } from './categories.js'
import { initSeed } from './seed.js'
import { decodeEvidence, encodeEvidence, evidenceToCodeIds, loadThemeEvidence } from './themes.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }

describe('theme evidence encoding', () => {
  it('round-trips a code entry through encode/decode', () => {
    const e = { kind: 'code' as const, ref: 'C-distrust', codebookId: 'CB-primary' }
    assert.equal(encodeEvidence(e), 'code:C-distrust:CB-primary')
    assert.deepEqual(decodeEvidence('code:C-distrust:CB-primary'), e)
  })

  it('round-trips a category entry', () => {
    assert.deepEqual(decodeEvidence('category:CAT-trust:CB-x'), {
      kind: 'category',
      ref: 'CAT-trust',
      codebookId: 'CB-x',
    })
  })

  it('tolerates a missing trailing codebook id', () => {
    assert.deepEqual(decodeEvidence('code:C-foo:'), { kind: 'code', ref: 'C-foo' })
    assert.deepEqual(decodeEvidence('code:C-foo'), { kind: 'code', ref: 'C-foo' })
  })

  it('rejects an unknown kind or empty ref', () => {
    assert.equal(decodeEvidence('term:T-x:CB-y'), null)
    assert.equal(decodeEvidence('code::CB-y'), null)
  })
})

describe('loadThemeEvidence (lazy-map)', () => {
  it('prefers evidence[] when present', () => {
    const ev = loadThemeEvidence({ evidence: ['code:C-a:CB-primary', 'category:CAT-b:CB-x'] })
    assert.deepEqual(ev, [
      { kind: 'code', ref: 'C-a', codebookId: 'CB-primary' },
      { kind: 'category', ref: 'CAT-b', codebookId: 'CB-x' },
    ])
  })

  it('lazy-maps a legacy codes[] theme to code evidence', () => {
    const ev = loadThemeEvidence({ codes: ['C-a', 'C-b'] })
    assert.deepEqual(ev, [
      { kind: 'code', ref: 'C-a' },
      { kind: 'code', ref: 'C-b' },
    ])
  })

  it('prefers evidence over a stale dual-written codes[]', () => {
    const ev = loadThemeEvidence({ evidence: ['code:C-new:CB-primary'], codes: ['C-old'] })
    assert.deepEqual(ev, [{ kind: 'code', ref: 'C-new', codebookId: 'CB-primary' }])
  })
})

describe('evidenceToCodeIds', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-themes-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('resolves a code entry to itself and a category entry to its member codes', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    createCode(path, { name: 'override', definition: 'o', author: RESEARCHER })
    createCategory(path, { name: 'agency', definition: 'a', author: RESEARCHER })
    linkCodeToCategory(path, { code: 'C-distrust', category: 'CAT-agency', author: RESEARCHER })
    linkCodeToCategory(path, { code: 'C-override', category: 'CAT-agency', author: RESEARCHER })

    const ids = evidenceToCodeIds(path, [
      { kind: 'code', ref: 'C-distrust' },
      { kind: 'category', ref: 'CAT-agency' },
    ])
    assert.deepEqual([...ids].sort(), ['C-primary/distrust', 'C-primary/override'])
  })

  it('a category resolves to its primary members only, not axial links', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    createCategory(path, { name: 'home', definition: 'h', author: RESEARCHER })
    createCategory(path, { name: 'axial', definition: 'x', author: RESEARCHER })
    // C-distrust's first link (CAT-home) is its primary home; the second
    // (CAT-axial, --no-primary) is a secondary/axial relationship.
    linkCodeToCategory(path, { code: 'C-distrust', category: 'CAT-home', author: RESEARCHER })
    linkCodeToCategory(path, {
      code: 'C-distrust',
      category: 'CAT-axial',
      primary: false,
      author: RESEARCHER,
    })
    // Primary home counts it; the axial category does not (ADR 0002 coverage).
    assert.deepEqual(evidenceToCodeIds(path, [{ kind: 'category', ref: 'CAT-home' }]), [
      'C-primary/distrust',
    ])
    assert.deepEqual(evidenceToCodeIds(path, [{ kind: 'category', ref: 'CAT-axial' }]), [])
  })
})

describe('createTheme evidence + cross-lens invariant', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-themes-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function readFm(path: string, id: string): string {
    return readFileSync(join(path, 'synthesis/themes', `${id.replace(/^T-/, '')}.md`), 'utf8')
  }

  it('writes evidence[] and dual-writes codes[] for a code-only theme', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'control',
      summary: 's',
      evidence: [{ kind: 'code', ref: 'C-distrust' }],
      author: RESEARCHER,
    })
    const fm = readFm(path, theme.id)
    assert.match(fm, /evidence: \[code:C-distrust:CB-primary\]/)
    assert.match(fm, /codes: \[C-distrust\]/) // deprecation-window dual write
    assert.match(fm, /codebook_id: CB-primary/) // inferred single frame
  })

  it('infers cross-lens (codebook_id: null) is rejected without a 2nd frame', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER }) // CB-primary
    assert.throws(
      () =>
        createTheme(path, {
          name: 'x',
          summary: 's',
          evidence: [{ kind: 'code', ref: 'C-a' }],
          codebookId: null, // explicit cross-lens, but all evidence is one frame
          author: RESEARCHER,
        }),
      (e: unknown) => e instanceof CompostError && /≥2 codebooks/.test((e as Error).message),
    )
  })

  it('accepts a cross-lens theme citing two codebooks (codebook_id: null)', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER }) // CB-primary
    createCode(path, { name: 'b', definition: 'd', codebookId: 'CB-lens-b', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'bridge',
      summary: 's',
      evidence: [
        { kind: 'code', ref: 'C-a' },
        { kind: 'code', ref: 'C-b' },
      ],
      codebookId: null,
      author: RESEARCHER,
    })
    const fm = readFm(path, theme.id)
    assert.match(fm, /codebook_id: null/)
    // Still code-only, so codes[] is dual-written for legacy readers.
    assert.match(fm, /codes: \[C-a, C-b\]/)
  })

  it('omits the legacy codes[] dual-write once a category enters the evidence', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER })
    createCategory(path, { name: 'grp', definition: 'g', author: RESEARCHER })
    linkCodeToCategory(path, { code: 'C-a', category: 'CAT-grp', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'mixed',
      summary: 's',
      evidence: [{ kind: 'category', ref: 'CAT-grp' }],
      author: RESEARCHER,
    })
    const fm = readFm(path, theme.id)
    assert.match(fm, /evidence: \[category:CAT-grp:CB-primary\]/)
    assert.doesNotMatch(fm, /\ncodes: /) // categories have no legacy codes[] form
  })

  it('rejects a scoped theme citing evidence from another frame', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER }) // CB-primary
    createCode(path, { name: 'b', definition: 'd', codebookId: 'CB-lens-b', author: RESEARCHER })
    assert.throws(
      () =>
        createTheme(path, {
          name: 'x',
          summary: 's',
          evidence: [
            { kind: 'code', ref: 'C-a' },
            { kind: 'code', ref: 'C-b' },
          ],
          codebookId: 'CB-primary',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError &&
        /single-lens theme stays within its frame/.test((e as Error).message),
    )
  })

  it('errors when evidence spans frames and neither --codebook nor --cross-lens is given', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER }) // CB-primary
    createCode(path, { name: 'b', definition: 'd', codebookId: 'CB-lens-b', author: RESEARCHER })
    assert.throws(
      () =>
        createTheme(path, {
          name: 'x',
          summary: 's',
          evidence: [
            { kind: 'code', ref: 'C-a' },
            { kind: 'code', ref: 'C-b' },
          ],
          // codebookId omitted → must NOT auto-infer cross-lens; require the flag.
          author: RESEARCHER,
        }),
      (e: unknown) => e instanceof CompostError && /spans 2 codebooks/.test((e as Error).message),
    )
  })

  it('infers a single-frame scope when all evidence shares one codebook', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'a', definition: 'd', author: RESEARCHER })
    createCode(path, { name: 'b', definition: 'd', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'scoped',
      summary: 's',
      evidence: [
        { kind: 'code', ref: 'C-a' },
        { kind: 'code', ref: 'C-b' },
      ],
      author: RESEARCHER,
    })
    assert.match(readFm(path, theme.id), /codebook_id: CB-primary/)
  })

  it('lazy-maps the legacy codes input through createTheme', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'legacy',
      summary: 's',
      codes: ['C-distrust'],
      author: RESEARCHER,
    })
    const fm = readFm(path, theme.id)
    assert.match(fm, /evidence: \[code:C-distrust:CB-primary\]/)
  })
})
