import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { codebookSlugOf, parseCodeId, qualifiedCodeId } from './codeRefs.js'

describe('code ref helpers (#269)', () => {
  it('strips the CB- prefix for the codebook slug', () => {
    assert.equal(codebookSlugOf('CB-epistemology'), 'epistemology')
    assert.equal(codebookSlugOf('primary'), 'primary') // already a slug
  })

  it('builds a qualified id', () => {
    assert.equal(qualifiedCodeId('CB-primary', 'distrust'), 'C-primary/distrust')
  })

  it('parses qualified and bare ids', () => {
    assert.deepEqual(parseCodeId('C-primary/distrust'), {
      codebookSlug: 'primary',
      codeSlug: 'distrust',
    })
    assert.deepEqual(parseCodeId('C-distrust'), { codeSlug: 'distrust' })
    assert.deepEqual(parseCodeId('distrust'), { codeSlug: 'distrust' }) // no C- prefix
  })
})

describe('resolveCodeRef (#269)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-coderefs-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  // Imported lazily so the helper-only tests above don't pay engine setup cost.
  async function seedTwoFrames() {
    const { createCode, createCodebook } = await import('./artifacts.js')
    const { initSeed } = await import('./seed.js')
    const { resolveCodeRef } = await import('./codeRefs.js')
    const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    // Distinct slugs per frame (createCode can't yet hold two same-named codes —
    // that's exactly what Option A's qualified paths unlock, tested in step 2).
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER }) // CB-primary
    createCode(path, {
      name: 'agency',
      definition: 'a',
      codebookId: 'CB-epistemology',
      author: RESEARCHER,
    })
    return { path, resolveCodeRef }
  }

  it('resolves a unique bare ref to its frame', async () => {
    const { path, resolveCodeRef } = await seedTwoFrames()
    assert.equal(resolveCodeRef(path, 'C-agency').codebookId, 'CB-epistemology')
    assert.equal(resolveCodeRef(path, 'C-distrust').codebookId, 'CB-primary')
  })

  it('resolves a qualified ref against a legacy bare-id code via its codebook_id', async () => {
    const { path, resolveCodeRef } = await seedTwoFrames()
    // The code is still stored as `C-agency` (legacy), but its frame is
    // CB-epistemology — a qualified ref must resolve it during the window.
    assert.equal(resolveCodeRef(path, 'C-epistemology/agency').codebookId, 'CB-epistemology')
  })

  it('does not match a qualified ref whose frame is wrong', async () => {
    const { path, resolveCodeRef } = await seedTwoFrames()
    assert.throws(
      () => resolveCodeRef(path, 'C-primary/agency'), // agency is in epistemology, not primary
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('throws NOT_FOUND for an unknown ref', async () => {
    const { path, resolveCodeRef } = await seedTwoFrames()
    assert.throws(
      () => resolveCodeRef(path, 'C-nope'),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })
})
