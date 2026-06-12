import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCategory, createCode, createCodebook } from './artifacts.js'
import { blame } from './blame.js'
import {
  linkCodeToCategory,
  listCategories,
  listCategoryLinks,
  resolveCategory,
  unlinkCodeFromCategory,
} from './categories.js'
import { initSeed } from './seed.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }

describe('createCategory', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-categories-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('writes CAT-slug markdown under categories/ with codebook_id + definition', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCategory(path, {
      name: 'Provenance as Epistemics',
      definition: 'Trust = construction kept visible + a knower held accountable.',
      author: RESEARCHER,
    })
    assert.equal(created.id, 'CAT-provenance-as-epistemics')
    assert.ok(created.path.endsWith('categories/provenance-as-epistemics.md'))
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /id: CAT-provenance-as-epistemics/)
    assert.match(md, /codebook_id: CB-primary/) // default frame
    assert.match(md, /Trust = construction kept visible/)

    // CAT- refs round-trip through blame (HUMAN_REF_RE widening).
    const lineage = blame('CAT-provenance-as-epistemics', { cwd: work, seed: 'demo' })
    assert.equal(lineage.events[0]?.artifact_kind, 'category')
  })

  it('belongs to an explicit codebook when given', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    const created = createCategory(path, {
      name: 'travel-of-claims',
      definition: 'how a claim gains force by traveling',
      codebookId: 'epistemology',
      author: RESEARCHER,
    })
    assert.match(readFileSync(created.path, 'utf8'), /codebook_id: CB-epistemology/)
  })

  it('rejects a category in a codebook that does not exist', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () =>
        createCategory(path, {
          name: 'x',
          definition: 'd',
          codebookId: 'nope',
          author: RESEARCHER,
        }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('does NOT live under codebook/ (no collision with the code-counting readers)', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCategory(path, { name: 'c', definition: 'd', author: RESEARCHER })
    assert.ok(!existsSync(join(path, 'codebook', 'c.md')))
    assert.ok(existsSync(join(path, 'categories', 'c.md')))
  })
})

describe('code↔category links (is_primary invariant)', () => {
  let work: string
  let path: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-catlink-'))
    path = initSeed('demo', { cwd: work }).path
    createCategory(path, { name: 'cat-a', definition: 'a', author: RESEARCHER })
    createCategory(path, { name: 'cat-b', definition: 'b', author: RESEARCHER })
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('first link for a code is its primary; a second is secondary (axial)', () => {
    const a = linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
    assert.equal(a.is_primary, true)
    const b = linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-b', author: RESEARCHER })
    assert.equal(b.is_primary, false)

    const links = listCategoryLinks(path).filter((l) => l.code === 'C-x')
    assert.equal(links.length, 2)
    assert.equal(links.filter((l) => l.is_primary).length, 1)
  })

  it('--primary demotes the existing primary so exactly one primary per code holds', () => {
    linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
    const promote = linkCodeToCategory(path, {
      code: 'C-x',
      category: 'CAT-cat-b',
      primary: true,
      author: RESEARCHER,
    })
    assert.equal(promote.is_primary, true)
    assert.equal(promote.demoted, 'CAT-cat-a')

    const primary = listCategoryLinks(path).filter((l) => l.code === 'C-x' && l.is_primary)
    assert.equal(primary.length, 1)
    assert.equal(primary[0]?.category, 'CAT-cat-b')
  })

  it('unlink archives the relationship (dropped from active links)', () => {
    linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
    const res = unlinkCodeFromCategory(path, {
      code: 'C-x',
      category: 'CAT-cat-a',
      author: RESEARCHER,
    })
    assert.equal(res.unlinked, true)
    assert.equal(listCategoryLinks(path).filter((l) => l.code === 'C-x').length, 0)
    // unlinking a non-existent link is a no-op, not an error.
    assert.equal(
      unlinkCodeFromCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
        .unlinked,
      false,
    )
  })

  it('list surfaces category membership with primary flags', () => {
    linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
    linkCodeToCategory(path, { code: 'C-y', category: 'CAT-cat-a', author: RESEARCHER })
    const cats = listCategories(path)
    assert.equal(cats.length, 2)
    const links = listCategoryLinks(path).filter((l) => l.category === 'CAT-cat-a')
    assert.equal(links.length, 2)
  })

  it('resolveCategory throws on an unknown ref, listing available', () => {
    assert.throws(
      () => resolveCategory(path, 'CAT-nope'),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /CAT-cat-a/.test(e.message),
    )
  })

  it("demote preserves the demoted link's codebook_id (link re-init must not strip the frame)", () => {
    linkCodeToCategory(path, {
      code: 'C-x',
      category: 'CAT-cat-a',
      codebookId: 'CB-primary',
      author: RESEARCHER,
    })
    linkCodeToCategory(path, {
      code: 'C-x',
      category: 'CAT-cat-b',
      codebookId: 'CB-primary',
      primary: true,
      author: RESEARCHER,
    })
    const demoted = listCategoryLinks(path).find((l) => l.category === 'CAT-cat-a')
    assert.ok(demoted)
    assert.equal(demoted.is_primary, false)
    assert.equal(demoted.codebook_id, 'CB-primary') // not dropped by the demote re-link
  })

  it("--no-primary refuses to strip a code's only/last primary", () => {
    linkCodeToCategory(path, { code: 'C-x', category: 'CAT-cat-a', author: RESEARCHER })
    // No other primary exists → demoting the sole home is refused.
    assert.throws(
      () =>
        linkCodeToCategory(path, {
          code: 'C-x',
          category: 'CAT-cat-a',
          primary: false,
          author: RESEARCHER,
        }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
    // But --no-primary IS allowed when another primary already carries the code.
    linkCodeToCategory(path, {
      code: 'C-x',
      category: 'CAT-cat-b',
      primary: false,
      author: RESEARCHER,
    })
    const links = listCategoryLinks(path).filter((l) => l.code === 'C-x')
    assert.equal(links.filter((l) => l.is_primary).length, 1)
    assert.equal(links.length, 2)
  })

  it('refuses to link a code into a category in a different frame (ADR 0002)', () => {
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    // A real code in the epistemology frame.
    createCode(path, {
      name: 'situated',
      definition: 's',
      codebookId: 'epistemology',
      author: RESEARCHER,
    })
    // cat-a is in CB-primary (created in beforeEach) → cross-frame.
    assert.throws(
      () =>
        linkCodeToCategory(path, {
          code: 'C-situated',
          category: 'CAT-cat-a',
          codebookId: 'CB-primary',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /one frame/.test(e.message),
    )
  })
})
