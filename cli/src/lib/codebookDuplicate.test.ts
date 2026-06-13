import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { createCode, createCodebook } from './artifacts.js'
import { blame } from './blame.js'
import { duplicateCodebook, listCodebooks } from './codebooks.js'
import { resolveCodeRef } from './codeRefs.js'
import { getArtifact } from './reads.js'
import { initSeed } from './seed.js'

const RESEARCHER_ID = 'juan@example.com'

/** The cloned code's current state (post-reduce). */
function codeState(seedPath: string, id: string) {
  const snap = getArtifact(seedPath, 'code', id)
  return snap?.current_state as
    | {
        id: string
        codebook_id: string
        name: string
        definition: string
        evidence: string[]
        derived_from?: string
      }
    | undefined
}

describe('duplicateCodebook (#269) — same-seed', () => {
  let work: string
  let seedPath: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-dup-'))
    seedPath = initSeed('study', { cwd: work }).path
    createCodebook(seedPath, {
      name: 'epistemology',
      stance: 'framework',
      description: "Haraway's situated-knowledge lens.",
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    createCode(seedPath, {
      name: 'situated-standpoint',
      definition: 'Knowledge is partial and located.',
      codebookId: 'CB-epistemology',
      evidence: ['H-001', 'H-002'],
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    createCode(seedPath, {
      name: 'positioned-objectivity',
      definition: 'Objectivity from a standpoint, not from nowhere.',
      codebookId: 'CB-epistemology',
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('creates a new frame copying stance + description, with all source codes cloned', () => {
    const result = duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID)
    assert.equal(result.codebook_id, 'CB-epistemology-v2')
    assert.equal(result.stance, 'framework')
    assert.equal(result.source_codebook_id, 'CB-epistemology')
    assert.equal(result.codes.length, 2)

    const books = listCodebooks(seedPath)
    const v2 = books.find((b) => (b.current_state as { id?: string }).id === 'CB-epistemology-v2')
    const v2state = v2?.current_state as { stance: string; description: string } | undefined
    assert.equal(v2state?.stance, 'framework')
    assert.equal(v2state?.description, "Haraway's situated-knowledge lens.")
    // Researcher-authored structural setup — born endorsed, not [draft].
    assert.equal(v2?.human_approved, true)
  })

  it('clones definitions but NOT evidence — the copy enters un-grounded', () => {
    const result = duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID)
    const cloned = result.codes.find((c) => c.from === 'C-epistemology/situated-standpoint')
    assert.ok(cloned, 'situated-standpoint was cloned')
    const st = codeState(seedPath, cloned.to)
    assert.equal(st?.codebook_id, 'CB-epistemology-v2')
    assert.equal(st?.definition, 'Knowledge is partial and located.')
    assert.deepEqual(st?.evidence, [], 'evidence does not travel')
    // Origin keeps its evidence untouched.
    assert.deepEqual(codeState(seedPath, 'C-epistemology/situated-standpoint')?.evidence, [
      'H-001',
      'H-002',
    ])
  })

  it('records a derived_from lineage link (frontmatter + create payload, visible in blame)', () => {
    const result = duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID)
    const cloned = result.codes.find((c) => c.from === 'C-epistemology/situated-standpoint')
    assert.ok(cloned, 'situated-standpoint was cloned')
    assert.equal(codeState(seedPath, cloned.to)?.derived_from, 'C-epistemology/situated-standpoint')

    const file = readFileSync(
      join(seedPath, 'codebook', 'epistemology-v2', 'situated-standpoint.md'),
      'utf8',
    )
    assert.match(file, /derived_from: C-epistemology\/situated-standpoint/)

    const b = blame(cloned.to, { cwd: work, seed: 'study' })
    const create = b.events.find((e) => e.action === 'create')
    assert.equal(
      (create?.payload as { derived_from?: string }).derived_from,
      'C-epistemology/situated-standpoint',
    )
  })

  it('cloned codes resolve and live in the new frame; the bare slug is now ambiguous', () => {
    duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID)
    // Qualified refs resolve to each frame distinctly.
    assert.equal(
      resolveCodeRef(seedPath, 'C-epistemology-v2/situated-standpoint').codebookId,
      'CB-epistemology-v2',
    )
    // The bare slug now exists in two frames → ambiguous (the collision the
    // qualified-id scheme exists to make addressable).
    assert.throws(() => resolveCodeRef(seedPath, 'situated-standpoint'), /ambiguous/)
  })

  it('refuses to overwrite an existing codebook', () => {
    duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID)
    assert.throws(
      () => duplicateCodebook(seedPath, 'epistemology', 'epistemology-v2', RESEARCHER_ID),
      /already exists/,
    )
  })

  it('refuses an in_vivo source — verbatim names cannot be re-homed without evidence', () => {
    createCodebook(seedPath, {
      name: 'emic',
      stance: 'in_vivo',
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    assert.throws(
      () => duplicateCodebook(seedPath, 'emic', 'emic-copy', RESEARCHER_ID),
      (err: unknown) => err instanceof CompostError && /in_vivo/.test(err.message),
    )
  })

  it('duplicates the implicit primary frame too', () => {
    createCode(seedPath, {
      name: 'orphan',
      definition: 'A primary-frame code.',
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    const result = duplicateCodebook(seedPath, 'primary', 'primary-copy', RESEARCHER_ID)
    assert.equal(result.stance, 'inductive')
    assert.ok(result.codes.some((c) => c.from === 'C-primary/orphan'))
  })
})

describe('duplicateCodebook (#269) — cross-seed (--from)', () => {
  let work: string
  let target: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-dupx-'))
    // Source study with a validated frame.
    const source = initSeed('prior-study', { cwd: work }).path
    createCodebook(source, {
      name: 'epistemology',
      stance: 'framework',
      description: 'A frame worth reusing.',
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    createCode(source, {
      name: 'situated-standpoint',
      definition: 'Knowledge is partial and located.',
      codebookId: 'CB-epistemology',
      evidence: ['H-009'],
      author: { actorType: 'researcher', actorId: RESEARCHER_ID },
    })
    // Fresh target study.
    target = initSeed('new-study', { cwd: work }).path
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('reuses a frame from a sibling seed; codes arrive un-grounded with a <seed>:<id> lineage', () => {
    const result = duplicateCodebook(target, 'epistemology', 'borrowed', RESEARCHER_ID, {
      fromSeed: 'prior-study',
    })
    assert.equal(result.source_seed, 'prior-study')
    assert.equal(result.codebook_id, 'CB-borrowed')
    assert.equal(result.codes.length, 1)

    const cloned = result.codes[0]
    assert.ok(cloned, 'one code cloned')
    const st = codeState(target, cloned.to)
    assert.equal(st?.codebook_id, 'CB-borrowed')
    assert.equal(st?.definition, 'Knowledge is partial and located.')
    assert.deepEqual(st?.evidence, [], 'cross-seed evidence cannot travel')
    assert.equal(st?.derived_from, 'prior-study:C-epistemology/situated-standpoint')
  })

  it('rejects a path-escaping --from seed name', () => {
    assert.throws(
      () =>
        duplicateCodebook(target, 'epistemology', 'x', RESEARCHER_ID, {
          fromSeed: '../prior-study',
        }),
      /Invalid --from seed/,
    )
  })

  it('errors clearly when the --from seed has no event log', () => {
    initSeed('empty', { cwd: work })
    assert.throws(
      () => duplicateCodebook(target, 'epistemology', 'x', RESEARCHER_ID, { fromSeed: 'empty' }),
      /No seed "empty" with an event log/,
    )
  })
})
