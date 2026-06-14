import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import {
  citeMemo,
  createCode,
  createMemo,
  createTheme,
  editMemo,
  endorseArtifact,
  rejectArtifact,
  updateArtifact,
} from './artifacts.js'
import { blame } from './blame.js'
import {
  decodeAnchor,
  encodeAnchor,
  getMemo,
  listMemos,
  type MemoAnchor,
  memosAbout,
} from './memos.js'
import { getArtifact } from './reads.js'
import { initSeed } from './seed.js'
import { evidenceToCodeIds, resolveThemeEvidence } from './themes.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const REVIEWER = { actorType: 'researcher' as const, actorId: 'reviewer@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.1.0:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

describe('encodeAnchor / decodeAnchor', () => {
  it('round-trips a frame-stamped anchor', () => {
    const a: MemoAnchor = { kind: 'code', ref: 'C-primary/distrust', codebookId: 'CB-primary' }
    assert.equal(encodeAnchor(a), 'code:C-primary/distrust:CB-primary')
    assert.deepEqual(decodeAnchor(encodeAnchor(a)), a)
  })

  it('round-trips a frame-less anchor', () => {
    const a: MemoAnchor = { kind: 'highlight', ref: 'H-001' }
    assert.equal(encodeAnchor(a), 'highlight:H-001:')
    assert.deepEqual(decodeAnchor('highlight:H-001:'), a)
  })

  it('rejects an unknown kind or empty ref', () => {
    assert.equal(decodeAnchor('bogus:X-1:'), null)
    assert.equal(decodeAnchor('code::'), null)
  })
})

describe('createMemo', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-memos-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('writes M-<slug> markdown with id/type/artifact_id and emits a create event', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, {
      title: 'Why distrust clusters around handoffs',
      content: 'Reading the handoff codes together, distrust seems procedural, not personal.',
      type: 'theme',
      author: RESEARCHER,
    })
    assert.equal(m.id, 'M-why-distrust-clusters-around-handoffs')
    assert.equal(m.artifact_id.length, 64)
    assert.ok(m.path.endsWith('synthesis/memos/why-distrust-clusters-around-handoffs.md'))

    const md = readFileSync(m.path, 'utf8')
    assert.match(md, /id: M-why-distrust-clusters-around-handoffs/)
    assert.match(md, /type: theme/)
    assert.match(md, new RegExp(`artifact_id: ${m.artifact_id}`))
    assert.match(md, /actor_type: researcher/)
    assert.match(md, /# Why distrust clusters around handoffs/)
    assert.match(md, /distrust seems procedural/)

    const result = blame(m.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]?.action, 'create')
  })

  it('defaults type to freeform and is readable via listMemos', () => {
    const { path } = initSeed('demo', { cwd: work })
    createMemo(path, { title: 'Stray thought', content: 'note to self', author: RESEARCHER })
    const memos = listMemos(path)
    assert.equal(memos.length, 1)
    assert.equal(memos[0]?.type, 'freeform')
    assert.equal(memos[0]?.title, 'Stray thought')
    assert.equal(memos[0]?.content, 'note to self')
    assert.equal(memos[0]?.human_approved, true) // researcher-authored ⇒ born endorsed
  })

  it('rejects an invalid type with a listing error (§10)', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () =>
        createMemo(path, { title: 'x', content: 'y', type: 'wat' as never, author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('rejects a duplicate title', () => {
    const { path } = initSeed('demo', { cwd: work })
    createMemo(path, { title: 'Dupe', content: 'a', author: RESEARCHER })
    assert.throws(
      () => createMemo(path, { title: 'Dupe', content: 'b', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('canonicalizes + frame-stamps a code anchor and infers the memo frame', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'wariness', author: RESEARCHER })
    const m = createMemo(path, {
      title: 'On distrust',
      content: 'reflecting',
      type: 'code',
      anchors: [{ kind: 'code', ref: 'distrust' }], // bare name ⇒ canonicalized
      author: RESEARCHER,
    })
    const md = readFileSync(m.path, 'utf8')
    assert.match(md, /anchors: \[code:C-primary\/distrust:CB-primary\]/)
    assert.match(md, /codebook_id: CB-primary/) // inferred from the single anchor frame

    const memo = listMemos(path)[0]
    assert.deepEqual(memo?.anchors, [
      { kind: 'code', ref: 'C-primary/distrust', codebookId: 'CB-primary' },
    ])
    assert.equal(memo?.codebookId, 'CB-primary')
  })

  it('supports a zero-anchor project-level reflexive memo (frame-less)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, {
      title: 'Positionality',
      content: 'I come to this corpus as an outsider.',
      type: 'reflexive',
      author: RESEARCHER,
    })
    const md = readFileSync(m.path, 'utf8')
    assert.doesNotMatch(md, /anchors:/)
    assert.match(md, /codebook_id: null/)
    assert.equal(listMemos(path)[0]?.codebookId, null)
  })
})

describe('memo endorsement gate', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-memos-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('AI-drafted memo is born [draft] and endorse (by a second actor) flips it', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'AI hunch', content: 'maybe a pattern', author: AI })
    assert.equal(listMemos(path)[0]?.human_approved, false)

    endorseArtifact(path, m.id, REVIEWER.actorId) // resolves the M- id (HUMAN_REF_RE)
    assert.equal(listMemos(path)[0]?.human_approved, true)

    const events = blame(m.id, { cwd: work, seed: 'demo' }).events.map((e) => e.action)
    assert.deepEqual(events, ['create', 'endorse'])
  })

  it('refuses a self-endorse', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'AI hunch', content: 'x', author: AI })
    assert.throws(
      () => endorseArtifact(path, m.id, AI.actorId),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('reject archives (excluded from listMemos unless includeArchived)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'AI hunch', content: 'x', author: AI })
    rejectArtifact(path, m.id, REVIEWER.actorId, 'off base')
    assert.equal(listMemos(path).length, 0)
    assert.equal(listMemos(path, { includeArchived: true }).length, 1)
  })

  it('edit emits an update event; the snapshot reflects the new content', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'Evolving', content: 'first pass', author: RESEARCHER })
    updateArtifact(
      path,
      m.id,
      { field: 'content', before: 'first pass', after: 'second pass' },
      RESEARCHER,
    )
    assert.equal(listMemos(path)[0]?.content, 'second pass')
    const actions = blame(m.id, { cwd: work, seed: 'demo' }).events.map((e) => e.action)
    assert.deepEqual(actions, ['create', 'update'])
  })
})

describe('memosAbout (backward link)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-memos-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('finds memos anchored to a code by bare or qualified ref', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'wariness', author: RESEARCHER })
    createMemo(path, {
      title: 'About distrust',
      content: 'r',
      anchors: [{ kind: 'code', ref: 'distrust' }],
      author: RESEARCHER,
    })
    createMemo(path, { title: 'Unrelated', content: 'r', author: RESEARCHER })

    assert.equal(memosAbout(path, 'distrust').length, 1)
    assert.equal(memosAbout(path, 'C-primary/distrust').length, 1)
    assert.equal(memosAbout(path, 'C-primary/trust').length, 0)
  })

  it('getArtifact resolves a memo by its M- id', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'Findable', content: 'r', author: RESEARCHER })
    const snap = getArtifact(path, 'memo', m.id)
    assert.equal(snap?.artifact_id, m.artifact_id)
  })
})

describe('memo as theme evidence (codable, no-inflate)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-memos-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('a theme cites a memo, frame-neutral, single-lens scoped by its code', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    const memo = createMemo(path, { title: 'note', content: 'c', author: RESEARCHER })
    const theme = createTheme(path, {
      name: 'Trust erosion',
      summary: 's',
      evidence: [
        { kind: 'code', ref: 'distrust' },
        { kind: 'memo', ref: memo.id },
      ],
      author: RESEARCHER,
    })
    const md = readFileSync(theme.path, 'utf8')
    // the memo doesn't make it cross-lens — it stays scoped to the code's frame
    assert.match(md, /codebook_id: CB-primary/)
    assert.match(md, new RegExp(`memo:${memo.id}:`))
  })

  it('a memo cited as evidence contributes no codes to coverage (§4)', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    const memo = createMemo(path, { title: 'note', content: 'c', author: RESEARCHER })
    const codeIds = evidenceToCodeIds(path, [
      { kind: 'code', ref: 'C-primary/distrust' },
      { kind: 'memo', ref: memo.id },
    ])
    assert.deepEqual(codeIds, ['C-primary/distrust'])
  })

  it('a memo-only theme is frame-less (a memo is not a lens)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const memo = createMemo(path, { title: 'n', content: 'c', author: RESEARCHER })
    const { evidence, codebookId } = resolveThemeEvidence(
      path,
      [{ kind: 'memo', ref: memo.id }],
      undefined,
    )
    assert.equal(codebookId, null)
    assert.equal(evidence.length, 1)
  })
})

describe('editMemo / citeMemo / getMemo', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-memos-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('editMemo updates content + type and reports the changed fields', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'Evolving', content: 'first', author: RESEARCHER })
    const res = editMemo(path, m.id, { content: 'second', type: 'theory', author: RESEARCHER })
    assert.deepEqual(res.updated.sort(), ['content', 'type'])
    const memo = getMemo(path, m.id)
    assert.equal(memo?.content, 'second')
    assert.equal(memo?.type, 'theory')
  })

  it('editMemo is a no-op when the value is unchanged', () => {
    const { path } = initSeed('demo', { cwd: work })
    const m = createMemo(path, { title: 'Same', content: 'x', author: RESEARCHER })
    const res = editMemo(path, m.id, { content: 'x', author: RESEARCHER })
    assert.deepEqual(res.updated, [])
  })

  it('citeMemo appends anchors and dedups (idempotent)', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'distrust', definition: 'd', author: RESEARCHER })
    const m = createMemo(path, { title: 'Grows', content: 'c', author: RESEARCHER })
    const first = citeMemo(path, m.id, [{ kind: 'code', ref: 'distrust' }], RESEARCHER)
    assert.equal(first.added, 1)
    assert.equal(getMemo(path, m.id)?.anchors.length, 1)
    // citing the same code again adds nothing (dedup by kind+ref, canonicalized)
    const again = citeMemo(path, m.id, [{ kind: 'code', ref: 'C-primary/distrust' }], RESEARCHER)
    assert.equal(again.added, 0)
    assert.equal(getMemo(path, m.id)?.anchors.length, 1)
  })

  it('getMemo returns null for a missing memo', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.equal(getMemo(path, 'M-nope'), null)
  })
})
