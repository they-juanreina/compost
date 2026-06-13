import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCategory, createCode, createCodebook, createTheme } from './artifacts.js'
import { blame } from './blame.js'
import { linkCodeToCategory } from './categories.js'
import { applyMerge, listCodebooks, planMerge } from './codebooks.js'
import { resolveCodeRef } from './codeRefs.js'
import { getArtifact } from './reads.js'
import { initSeed } from './seed.js'

const RID = 'juan@example.com'
const AUTHOR = { actorType: 'researcher' as const, actorId: RID }

function codeState(seedPath: string, id: string) {
  return getArtifact(seedPath, 'code', id)?.current_state as
    | { id: string; codebook_id: string; name: string; evidence: string[] }
    | undefined
}
function isLive(seedPath: string, cbId: string): boolean {
  return listCodebooks(seedPath).some((s) => (s.current_state as { id?: string }).id === cbId)
}

describe('mergeCodebooks (#269)', () => {
  let work: string
  let seedPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-merge-'))
    seedPath = initSeed('study', { cwd: work }).path
    createCodebook(seedPath, { name: 'lens-a', stance: 'framework', author: AUTHOR })
    createCodebook(seedPath, { name: 'lens-b', stance: 'framework', author: AUTHOR })
    createCode(seedPath, {
      name: 'alpha',
      definition: 'A-only code.',
      codebookId: 'CB-lens-a',
      evidence: ['H-001', 'H-002'],
      author: AUTHOR,
    })
    createCode(seedPath, {
      name: 'shared',
      definition: 'Shared name, lens A reading.',
      codebookId: 'CB-lens-a',
      author: AUTHOR,
    })
    createCode(seedPath, {
      name: 'shared',
      definition: 'Shared name, lens B reading.',
      codebookId: 'CB-lens-b',
      author: AUTHOR,
    })
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('re-homes codes into the target frame and reject-archives the source', () => {
    const result = applyMerge(seedPath, 'lens-a', 'lens-b', RID)
    assert.equal(result.from, 'CB-lens-a')
    assert.equal(result.into, 'CB-lens-b')
    assert.equal(result.archived_from, true)
    assert.equal(result.codes.length, 2)

    // Source frame is archived (no longer listed), target still live.
    assert.equal(isLive(seedPath, 'CB-lens-a'), false)
    assert.equal(getArtifact(seedPath, 'codebook', 'CB-lens-a')?.archived, true)
    assert.equal(isLive(seedPath, 'CB-lens-b'), true)
  })

  it('preserves identity + evidence on re-home (an update, not a copy)', () => {
    const before = getArtifact(seedPath, 'code', 'C-lens-a/alpha')?.artifact_id
    applyMerge(seedPath, 'lens-a', 'lens-b', RID)
    const st = codeState(seedPath, 'C-lens-b/alpha')
    assert.equal(st?.codebook_id, 'CB-lens-b')
    assert.deepEqual(st?.evidence, ['H-001', 'H-002'], 'evidence carries over')
    // Same SHA identity (re-home is an update, not a fresh create).
    assert.equal(getArtifact(seedPath, 'code', 'C-lens-b/alpha')?.artifact_id, before)
    // File moved to the target frame's dir.
    assert.ok(existsSync(join(seedPath, 'codebook', 'lens-b', 'alpha.md')))
    assert.ok(!existsSync(join(seedPath, 'codebook', 'lens-a', 'alpha.md')))
  })

  it('keeps colliding names distinct — renames within the frame, recorded in blame', () => {
    const result = applyMerge(seedPath, 'lens-a', 'lens-b', RID)
    const moved = result.codes.find((c) => c.from_id === 'C-lens-a/shared')
    assert.ok(moved)
    assert.equal(moved.renamed, true)
    assert.equal(moved.to_id, 'C-lens-b/shared-from-lens-a')

    // Both codes coexist, distinct, in the target frame.
    assert.equal(resolveCodeRef(seedPath, 'C-lens-b/shared').codebookId, 'CB-lens-b')
    assert.equal(resolveCodeRef(seedPath, 'C-lens-b/shared-from-lens-a').codebookId, 'CB-lens-b')

    // The rename is in the event log (an update{field:name}).
    const b = blame('C-lens-b/shared-from-lens-a', { cwd: work, seed: 'study' })
    const nameUpdate = b.events.find(
      (e) => e.action === 'update' && (e.payload as { field?: string }).field === 'name',
    )
    assert.equal((nameUpdate?.payload as { after?: string }).after, 'shared-from-lens-a')
  })

  it('coverage math sees the merged-in code as distinct (not fused)', () => {
    applyMerge(seedPath, 'lens-a', 'lens-b', RID)
    // lens-b now holds alpha + shared (its own) + shared-from-lens-a = 3 codes.
    const inB = ['C-lens-b/alpha', 'C-lens-b/shared', 'C-lens-b/shared-from-lens-a']
    for (const id of inB) assert.equal(codeState(seedPath, id)?.codebook_id, 'CB-lens-b')
  })

  it('dry-run (planMerge) computes the plan without mutating', () => {
    const plan = planMerge(seedPath, 'lens-a', 'lens-b')
    assert.equal(plan.codes.length, 2)
    assert.ok(plan.codes.some((c) => c.renamed && c.to_id === 'C-lens-b/shared-from-lens-a'))
    // Nothing changed.
    assert.equal(isLive(seedPath, 'CB-lens-a'), true)
    assert.equal(codeState(seedPath, 'C-lens-a/alpha')?.codebook_id, 'CB-lens-a')
  })

  it('refuses merging a frame into itself, the primary away, or an archived frame', () => {
    assert.throws(() => planMerge(seedPath, 'lens-a', 'lens-a'), /into itself/)
    assert.throws(() => planMerge(seedPath, 'primary', 'lens-b'), /primary frame away/)
    applyMerge(seedPath, 'lens-a', 'lens-b', RID) // archives lens-a
    assert.throws(() => planMerge(seedPath, 'lens-a', 'lens-b'), /archived or unknown/)
  })

  it('refuses when a re-homing code is cited by a theme (would change its lens membership)', () => {
    createTheme(seedPath, {
      name: 'a-theme',
      summary: 'Cites a lens-a code.',
      evidence: [{ kind: 'code', ref: 'C-lens-a/alpha' }],
      author: AUTHOR,
    })
    assert.throws(
      () => applyMerge(seedPath, 'lens-a', 'lens-b', RID),
      (err: unknown) => err instanceof CompostError && /theme/.test(err.message),
    )
    // Refusal is transactional — nothing moved.
    assert.equal(isLive(seedPath, 'CB-lens-a'), true)
  })

  it('refuses when a re-homing code is linked to a category', () => {
    createCategory(seedPath, {
      name: 'group-a',
      definition: 'A lens-a category.',
      codebookId: 'CB-lens-a',
      author: AUTHOR,
    })
    linkCodeToCategory(seedPath, {
      code: 'C-lens-a/alpha',
      category: 'CAT-group-a',
      codebookId: 'CB-lens-a',
      author: AUTHOR,
    })
    const plan = planMerge(seedPath, 'lens-a', 'lens-b')
    assert.equal(plan.blocking.category_links.length, 1)
    assert.throws(
      () => applyMerge(seedPath, 'lens-a', 'lens-b', RID),
      (err: unknown) => err instanceof CompostError && /category link/.test(err.message),
    )
  })
})
