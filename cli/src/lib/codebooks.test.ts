import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import {
  createCode,
  createCodebook,
  DEFAULT_CODEBOOK_ID,
  endorseArtifact,
  ensurePrimaryCodebook,
  rejectArtifact,
} from './artifacts.js'
import { blame } from './blame.js'
import {
  applyCodebookMigration,
  applyCodeIdMigration,
  listCodebooks,
  planCodebookMigration,
  planCodeIdMigration,
} from './codebooks.js'
import { resolveCodeRef } from './codeRefs.js'
import { emitAgentCreate, emitCreate, openSeedEvents } from './events.js'
import { initSeed } from './seed.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }

describe('createCodebook / ensurePrimaryCodebook', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-codebooks-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('init scaffolds an empty codebooks/ dir but writes no events (pure scaffold)', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.ok(existsSync(join(path, 'codebooks')), 'codebooks/ dir scaffolded')
    // Lazy: no primary.md and no events.sqlite until research activity begins.
    assert.ok(!existsSync(join(path, 'codebooks', 'primary.md')))
    assert.ok(!existsSync(join(path, '.compost', 'events.sqlite')))
    assert.equal(listCodebooks(path).length, 0)
  })

  it('ensurePrimaryCodebook materializes a researcher-authored, endorsed primary', () => {
    const { path } = initSeed('demo', { cwd: work })
    const primary = ensurePrimaryCodebook(path)
    assert.equal(primary.created, true)
    assert.equal(primary.id, DEFAULT_CODEBOOK_ID)
    assert.ok(existsSync(join(path, 'codebooks', 'primary.md')))

    const books = listCodebooks(path)
    assert.equal(books.length, 1)
    const state = books[0]?.current_state as { id: string; stance: string }
    assert.equal(state.id, 'CB-primary')
    assert.equal(state.stance, 'inductive')
    // Researcher-authored structural default — born endorsed, not [draft].
    assert.equal(books[0]?.human_approved, true)
  })

  it('writes CB-slug markdown with stance + seed_id frontmatter and emits a create event', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCodebook(path, {
      name: 'Pluriversal Justice',
      stance: 'framework',
      description: 'A justice reading of the corpus.',
      author: RESEARCHER,
    })
    assert.equal(created.id, 'CB-pluriversal-justice')
    assert.ok(created.path.endsWith('codebooks/pluriversal-justice.md'))

    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /id: CB-pluriversal-justice/)
    assert.match(md, /stance: framework/)
    assert.match(md, /seed_id: demo/)
    assert.match(md, /A justice reading of the corpus\./)

    const result = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(result.events[0]?.action, 'create')
    assert.equal(result.events[0]?.artifact_kind, 'codebook')
  })

  it('rejects an unknown stance, listing the valid ones', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () => createCodebook(path, { name: 'bad', stance: 'vibes' as never, author: RESEARCHER }),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /in_vivo/.test(e.message),
    )
  })

  it('refuses to overwrite an existing codebook', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'dup', stance: 'inductive', author: RESEARCHER })
    assert.throws(
      () => createCodebook(path, { name: 'dup', stance: 'deductive', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('ensurePrimaryCodebook is idempotent on the file', () => {
    const { path } = initSeed('demo', { cwd: work })
    const first = ensurePrimaryCodebook(path)
    assert.equal(first.created, true)
    const again = ensurePrimaryCodebook(path)
    assert.equal(again.created, false)
    assert.equal(again.id, DEFAULT_CODEBOOK_ID)
    assert.equal(listCodebooks(path).length, 1)
  })

  it('CB- refs round-trip through endorse (HUMAN_REF_RE widening)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCodebook(path, {
      name: 'epistemology',
      stance: 'framework',
      author: RESEARCHER,
    })
    const endorsed = endorseArtifact(path, 'CB-epistemology', 'reviewer@example.com')
    assert.equal(endorsed.artifact_id, created.artifact_id)
  })
})

describe('codebook_id on codes', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-codebooks-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('defaults a new code to CB-primary in payload + frontmatter', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, { name: 'distrust', definition: 'x', author: RESEARCHER })
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /codebook_id: CB-primary/)
  })

  it('accepts an explicit codebook by name or CB- id', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    const byName = createCode(path, {
      name: 'situated-standpoint',
      definition: 'x',
      codebookId: 'epistemology',
      author: RESEARCHER,
    })
    assert.match(readFileSync(byName.path, 'utf8'), /codebook_id: CB-epistemology/)
    const byId = createCode(path, {
      name: 'modality-stripping',
      definition: 'x',
      codebookId: 'CB-epistemology',
      author: RESEARCHER,
    })
    assert.match(readFileSync(byId.path, 'utf8'), /codebook_id: CB-epistemology/)
  })

  it('rejects a code aimed at a codebook that does not exist, listing available ones', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    assert.throws(
      () =>
        createCode(path, {
          name: 'orphan',
          definition: 'x',
          codebookId: 'epistemoloy', // typo
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError &&
        e.code === 'INVALID_INPUT' &&
        /CB-epistemology/.test(e.message),
    )
  })

  it('rejects an explicit codebook ref in a seed with no codebooks (clean message, no raw DB error)', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () =>
        createCode(path, {
          name: 'orphan',
          definition: 'x',
          codebookId: 'epistemology',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError &&
        e.code === 'INVALID_INPUT' &&
        /No codebook/.test(e.message) &&
        !/events\.sqlite/.test(e.message),
    )
  })

  it('a default-codebook code stamps CB-primary with no codebook side-effect (one event)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, { name: 'late', definition: 'x', author: RESEARCHER })
    assert.match(readFileSync(created.path, 'utf8'), /codebook_id: CB-primary/)
    // The implicit default frame needs no artifact — createCode must not
    // materialize one (keeps one-code = one-event; no $USER-dependent actor).
    assert.ok(!existsSync(join(path, 'codebooks', 'primary.md')))
    assert.equal(listCodebooks(path).length, 0)

    // Exactly one create event landed: the code itself.
    const lineage = blame('C-late', { cwd: work, seed: 'demo' })
    assert.equal(lineage.events.filter((e) => e.action === 'create').length, 1)
  })
})

describe('codebook migration (plan/apply)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-codebooks-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  /** A pre-slice seed: a code created without codebook_id (raw event + file),
   * plus an event-only scanner draft, and no codebooks/ at all. */
  function preSliceSeed(): string {
    const { path } = initSeed('demo', { cwd: work })
    rmSync(join(path, 'codebooks'), { recursive: true, force: true })
    rmSync(join(path, '.compost', 'events.sqlite'), { force: true })

    // File-backed code without codebook_id, written the pre-slice way.
    const initialState = {
      id: 'C-legacy',
      kind: 'code',
      name: 'legacy',
      definition: 'd',
      evidence: [],
    }
    const events = openSeedEvents(path)
    try {
      emitCreate(events, {
        artifactKind: 'code',
        initialState,
        author: { actorType: 'researcher', actorId: 'juan@example.com' },
      })
      // Event-only scanner draft (no file, no human id).
      emitAgentCreate(events, {
        artifactKind: 'code',
        initialState: { kind: 'code', members: ['H-001'], cohesion: 0.9, status: 'draft' },
        agentName: 'similarity-scanner',
        agentVersion: '0.1.0',
      })
    } finally {
      events.close()
    }
    writeFileSync(
      join(path, 'codebook', 'legacy.md'),
      '---\nid: C-legacy\nname: legacy\nevidence: []\n---\nd\n',
      'utf8',
    )
    return path
  }

  it('plans: flags missing primary + both un-stamped codes', () => {
    const path = preSliceSeed()
    const plan = planCodebookMigration(path)
    assert.equal(plan.needs_primary, true)
    assert.equal(plan.codes.length, 2)
    const fileBacked = plan.codes.find((c) => c.ref === 'C-legacy')
    assert.ok(fileBacked)
    assert.equal(fileBacked.file, join('codebook', 'legacy.md'))
  })

  it('applies: creates primary, emits update events, rewrites frontmatter; lazy reads agree', () => {
    const path = preSliceSeed()
    const result = applyCodebookMigration(path, 'juan@example.com')
    assert.equal(result.primary_created, true)
    assert.equal(result.updated.length, 2)

    const md = readFileSync(join(path, 'codebook', 'legacy.md'), 'utf8')
    assert.match(md, /codebook_id: CB-primary/)

    // The update event landed on the timeline and reduces into the snapshot.
    const lineage = blame('C-legacy', { cwd: work, seed: 'demo' })
    const update = lineage.events.find((e) => e.action === 'update')
    assert.ok(update)

    // Second run is a no-op plan.
    const again = planCodebookMigration(path)
    assert.equal(again.codes.length, 0)
    assert.equal(again.needs_primary, false)
  })

  it('stamps file-only codes (no event) and reports them, not silently skips', () => {
    const { path } = initSeed('demo', { cwd: work })
    // A code that exists only as a markdown file — no create event (sample
    // fixture / imported codebook shape).
    writeFileSync(
      join(path, 'codebook', 'orphan-file.md'),
      '---\nid: C-orphan-file\nname: orphan-file\nevidence: []\n---\nd\n',
      'utf8',
    )
    const plan = planCodebookMigration(path)
    assert.equal(plan.codes.length, 0, 'no event-backed codes')
    assert.deepEqual(plan.file_only, [join('codebook', 'orphan-file.md')])

    const result = applyCodebookMigration(path, 'juan@example.com')
    assert.deepEqual(result.file_only_stamped, [join('codebook', 'orphan-file.md')])
    assert.match(
      readFileSync(join(path, 'codebook', 'orphan-file.md'), 'utf8'),
      /codebook_id: CB-primary/,
    )
    // No event was emitted for a file-only code (it has no provenance record).
    assert.equal(plan.codes.length, 0)
  })

  it('leaves a rejected (archived) legacy code untouched — no resurrection via file-only', () => {
    const path = preSliceSeed()
    // Reject the event-backed legacy code; its codebook/legacy.md stays on disk
    // (reject archives, never deletes).
    rejectArtifact(path, 'C-legacy', 'reviewer@example.com')

    const plan = planCodebookMigration(path)
    // Must NOT appear as an event-backed migration target (archived)…
    assert.ok(!plan.codes.some((c) => c.ref === 'C-legacy'))
    // …and must NOT be misclassified as a file-only orphan (its file is known).
    assert.ok(!plan.file_only.includes(join('codebook', 'legacy.md')))

    const before = readFileSync(join(path, 'codebook', 'legacy.md'), 'utf8')
    const result = applyCodebookMigration(path, 'juan@example.com')
    assert.ok(!result.file_only_stamped.includes(join('codebook', 'legacy.md')))
    // The rejected code's file is left exactly as it was — not resurrected.
    assert.equal(readFileSync(join(path, 'codebook', 'legacy.md'), 'utf8'), before)
  })
})

describe('code-id qualification (#269)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-migrate-ids-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  /** A legacy flat bare-id code `C-legacy` (codebook_id=CB-epistemology) with a
   * real create event — the pre-#269 on-disk shape. */
  function legacyCodeSeed(): string {
    const { path } = initSeed('demo', { cwd: work })
    const events = openSeedEvents(path)
    try {
      emitCreate(events, {
        artifactKind: 'code',
        initialState: {
          id: 'C-legacy',
          kind: 'code',
          codebook_id: 'CB-epistemology',
          name: 'legacy',
          definition: 'd',
          evidence: [],
        },
        author: RESEARCHER,
      })
    } finally {
      events.close()
    }
    writeFileSync(
      join(path, 'codebook', 'legacy.md'),
      '---\nid: C-legacy\nname: legacy\ncodebook_id: CB-epistemology\nevidence: []\n---\nd\n',
      'utf8',
    )
    return path
  }

  it('plans a legacy flat code → namespaced, and counts already-qualified codes', () => {
    const path = legacyCodeSeed()
    // A code created the new way is already namespaced.
    createCode(path, { name: 'fresh', definition: 'd', author: RESEARCHER })

    const plan = planCodeIdMigration(path)
    assert.deepEqual(
      plan.codes.map((c) => ({ from: c.old_id, to: c.new_id })),
      [{ from: 'C-legacy', to: 'C-epistemology/legacy' }],
    )
    assert.equal(plan.already_qualified, 1) // C-primary/fresh
  })

  it('applies: moves the file, qualifies the id, and records a rename event', () => {
    const path = legacyCodeSeed()
    const res = applyCodeIdMigration(path, 'juan@example.com')
    assert.deepEqual(res.migrated, [
      { old_id: 'C-legacy', new_id: 'C-epistemology/legacy', event_emitted: true },
    ])

    // File moved to the namespaced path with the qualified id; flat one gone.
    assert.ok(!existsSync(join(path, 'codebook', 'legacy.md')))
    const moved = readFileSync(join(path, 'codebook', 'epistemology', 'legacy.md'), 'utf8')
    assert.match(moved, /id: C-epistemology\/legacy/)

    // Resolves by BOTH the new qualified id and the old bare shorthand.
    assert.equal(resolveCodeRef(path, 'C-epistemology/legacy').id, 'C-epistemology/legacy')
    assert.equal(resolveCodeRef(path, 'C-legacy').id, 'C-epistemology/legacy')

    // Provenance preserved: blame on the qualified id shows create → update(id).
    const lineage = blame('C-epistemology/legacy', { cwd: work, seed: 'demo' })
    assert.equal(lineage.events.length, 2)
    assert.deepEqual(
      lineage.events.map((e) => e.action),
      ['create', 'update'],
    )
  })

  it('is idempotent — a second apply migrates nothing', () => {
    const path = legacyCodeSeed()
    applyCodeIdMigration(path, 'juan@example.com')
    assert.deepEqual(applyCodeIdMigration(path, 'juan@example.com').migrated, [])
    assert.deepEqual(planCodeIdMigration(path).codes, [])
  })

  it('migrates a file-only code (no create event) without an event', () => {
    const { path } = initSeed('demo', { cwd: work })
    // Hand-authored flat code, no create event behind it.
    writeFileSync(
      join(path, 'codebook', 'orphan.md'),
      '---\nid: C-orphan\nname: orphan\nevidence: []\n---\nd\n',
      'utf8',
    )
    const res = applyCodeIdMigration(path, 'juan@example.com')
    assert.deepEqual(res.migrated, [
      { old_id: 'C-orphan', new_id: 'C-primary/orphan', event_emitted: false },
    ])
    assert.ok(existsSync(join(path, 'codebook', 'primary', 'orphan.md')))
    assert.ok(!existsSync(join(path, 'codebook', 'orphan.md')))
  })

  it('a file-only code never renames an unrelated same-slug namespaced code (#269 review)', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    // A real, event-backed code C-epistemology/orphan...
    const sibling = createCode(path, {
      name: 'orphan',
      definition: 'real',
      codebookId: 'epistemology',
      author: RESEARCHER,
    })
    // ...and a hand-authored flat file-only C-orphan (no create event).
    writeFileSync(
      join(path, 'codebook', 'orphan.md'),
      '---\nid: C-orphan\nname: orphan\nevidence: []\n---\nd\n',
      'utf8',
    )
    const res = applyCodeIdMigration(path, 'juan@example.com')
    // The file-only code migrates WITHOUT emitting an event (no own create event)…
    assert.deepEqual(res.migrated, [
      { old_id: 'C-orphan', new_id: 'C-primary/orphan', event_emitted: false },
    ])
    // …and the sibling's provenance + id are untouched (only its create event).
    assert.deepEqual(
      blame(sibling.id, { cwd: work, seed: 'demo' }).events.map((e) => e.action),
      ['create'],
    )
    assert.equal(resolveCodeRef(path, 'C-epistemology/orphan').id, 'C-epistemology/orphan')
  })

  it('refuses to migrate when a target would overwrite an existing code (#269 review)', () => {
    const { path } = initSeed('demo', { cwd: work })
    // An already-namespaced code at codebook/primary/distrust.md.
    createCode(path, { name: 'distrust', definition: 'KEEP-ME', author: RESEARCHER })
    // A legacy flat code that would target the SAME path (frame primary, slug distrust).
    writeFileSync(
      join(path, 'codebook', 'distrust.md'),
      '---\nid: C-distrust\nname: distrust\nevidence: []\n---\nlegacy\n',
      'utf8',
    )
    assert.equal(planCodeIdMigration(path).conflicts.length, 1)
    assert.throws(
      () => applyCodeIdMigration(path, 'juan@example.com'),
      (e: unknown) => e instanceof CompostError && /overwrite an existing code/.test(e.message),
    )
    // Nothing was clobbered: the original namespaced code's body survives.
    assert.match(readFileSync(join(path, 'codebook', 'primary', 'distrust.md'), 'utf8'), /KEEP-ME/)
  })
})
