import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { SnapshotStore } from '@they-juanreina/compost-provenance'
import Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import {
  createCategory,
  createCode,
  createCodebook,
  createHighlight,
  createMemo,
  createTheme,
  endorseArtifact,
  rejectArtifact,
  updateArtifact,
} from './artifacts.js'
import { blame } from './blame.js'
import { linkCodeToCategory } from './categories.js'
import { duplicateCodebook } from './codebooks.js'
import { type Author, emitCreate, eventsDbPath, openSeedEvents } from './events.js'
import { listByKind, type ThemeEvidenceDetail } from './list.js'
import { getArtifact } from './reads.js'
import { gatherSessionsWithThemes } from './saturate.js'
import { initSeed } from './seed.js'
import { editThemeEvidence, restampEvidence } from './themeEvidence.js'
import { loadThemeEvidence, themeEvidenceFromState } from './themes.js'

const RESEARCHER: Author = { actorType: 'researcher', actorId: 'juan@example.com' }
const AI: Author = {
  actorType: 'ai',
  actorId: 'claude-code:0.2.2:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

function catchErr(fn: () => unknown): CompostError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof CompostError, `expected a CompostError, got ${String(err)}`)
    return err
  }
  assert.fail('expected a CompostError')
}

interface EventRow {
  action: string
  actor_type: string
  actor_id: string
  model: string | null
  prompt_hash: string | null
  payload: string
}

function themeEvents(seed: string, artifactId: string): EventRow[] {
  const db = new Database(eventsDbPath(seed), { readonly: true })
  try {
    return db
      .prepare(
        'SELECT action, actor_type, actor_id, model, prompt_hash, payload FROM events WHERE artifact_id = ? ORDER BY ts, id',
      )
      .all(artifactId) as EventRow[]
  } finally {
    db.close()
  }
}

function eventCount(seed: string): number {
  const db = new Database(eventsDbPath(seed), { readonly: true })
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  } finally {
    db.close()
  }
}

const refs = (es: Array<{ kind: string; ref: string }>): string[] =>
  es.map((e) => `${e.kind}:${e.ref}`)

/** The evidence tokens + legacy codes a file reader (saturate) would see. */
function frontmatterOf(path: string): { evidence?: string[]; codes?: string[]; text: string } {
  const text = readFileSync(path, 'utf8')
  const arr = (key: string): string[] | undefined => {
    const m = new RegExp(`^${key}: \\[(.*)\\]$`, 'm').exec(text)
    if (m === null) return undefined
    return (m[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  const evidence = arr('evidence')
  const codes = arr('codes')
  return {
    text,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(codes !== undefined ? { codes } : {}),
  }
}

describe('editThemeEvidence (#335)', () => {
  let work: string
  let seed: string
  let themeId: string
  let themePath: string
  let themeSha: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-theme-evidence-'))
    seed = initSeed('demo', { cwd: work }).path
    createCode(seed, { name: 'distrust', definition: 'd', author: RESEARCHER })
    createCode(seed, { name: 'override', definition: 'o', author: RESEARCHER })
    createCode(seed, { name: 'workaround', definition: 'w', author: RESEARCHER })
    createCategory(seed, { name: 'agency', definition: 'a', author: RESEARCHER })
    const theme = createTheme(seed, {
      name: 'control',
      summary: 'People want the last word.',
      evidence: [{ kind: 'code', ref: 'C-distrust' }],
      author: RESEARCHER,
    })
    themeId = theme.id
    themePath = theme.path
    themeSha = theme.artifact_id
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  const ledgerEvidence = (ref: string = themeId): string[] => {
    const snap = getArtifact(seed, 'theme', ref)
    assert.ok(snap !== null)
    return refs(themeEvidenceFromState(snap.current_state))
  }

  describe('add', () => {
    it('adds a code: one update event, ledger + markdown both carry it', () => {
      const before = eventCount(seed)
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.equal(r.id, themeId)
      assert.equal(r.artifact_id, themeSha)
      assert.deepEqual(r.added, [
        { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
      ])
      assert.deepEqual(r.removed, [])
      assert.deepEqual(refs(r.evidence), ['code:C-distrust', 'code:C-primary/override'])
      assert.equal(r.codebook_id, 'CB-primary')
      assert.equal(r.file_rewritten, true)
      assert.equal(typeof r.update_event_id, 'string')

      assert.equal(eventCount(seed), before + 1, 'exactly one event')
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'code:C-primary/override'])

      const fm = frontmatterOf(themePath)
      assert.deepEqual(fm.evidence, [
        'code:C-distrust:CB-primary',
        'code:C-primary/override:CB-primary',
      ])
      assert.deepEqual(fm.codes, ['C-distrust', 'C-primary/override'], 'legacy codes dual-write')
    })

    it('adds a category: the legacy codes line is dropped, as create does', () => {
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'category', ref: 'agency' }] }, // by name → canonical CAT- id
        RESEARCHER,
      )
      assert.deepEqual(r.added, [
        { kind: 'category', ref: 'CAT-agency', codebook_id: 'CB-primary' },
      ])
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'category:CAT-agency'])
      const fm = frontmatterOf(themePath)
      assert.deepEqual(fm.evidence, [
        'code:C-distrust:CB-primary',
        'category:CAT-agency:CB-primary',
      ])
      assert.equal(fm.codes, undefined, 'codes[] is only dual-written while every entry is a code')
    })

    it('accepts a SHA prefix as the theme ref', () => {
      const r = editThemeEvidence(
        seed,
        themeSha.slice(0, 12),
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.id, themeId)
      assert.equal(r.changed, true)
    })

    it('rewrites only the evidence/codes lines — every other byte of the markdown is kept', () => {
      const original = readFileSync(themePath, 'utf8')
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
      const strip = (t: string): string =>
        t
          .split('\n')
          .filter((l) => !/^(evidence|codes):/.test(l))
          .join('\n')
      assert.equal(strip(readFileSync(themePath, 'utf8')), strip(original))
      assert.match(readFileSync(themePath, 'utf8'), /\n# control\n\nPeople want the last word\.\n$/)
    })
  })

  describe('remove', () => {
    beforeEach(() => {
      editThemeEvidence(
        seed,
        themeId,
        {
          add: [
            { kind: 'code', ref: 'C-override' },
            { kind: 'category', ref: 'CAT-agency' },
          ],
        },
        RESEARCHER,
      )
    })

    it('removes a code', () => {
      const before = eventCount(seed)
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-distrust' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.deepEqual(refs(r.removed), ['code:C-distrust'])
      assert.deepEqual(ledgerEvidence(), ['code:C-primary/override', 'category:CAT-agency'])
      assert.equal(eventCount(seed), before + 1)
      assert.deepEqual(frontmatterOf(themePath).evidence, [
        'code:C-primary/override:CB-primary',
        'category:CAT-agency:CB-primary',
      ])
    })

    it('removes a category: the legacy codes line comes back once the set is code-only', () => {
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'category', ref: 'CAT-agency' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(r.removed), ['category:CAT-agency'])
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'code:C-primary/override'])
      assert.deepEqual(frontmatterOf(themePath).codes, ['C-distrust', 'C-primary/override'])
    })

    it('adds and removes in one call as a single event (a swap)', () => {
      const before = eventCount(seed)
      const r = editThemeEvidence(
        seed,
        themeId,
        {
          add: [{ kind: 'code', ref: 'C-workaround' }],
          remove: [
            { kind: 'code', ref: 'C-distrust' },
            { kind: 'code', ref: 'C-override' },
            { kind: 'category', ref: 'CAT-agency' },
          ],
        },
        RESEARCHER,
      )
      assert.equal(eventCount(seed), before + 1)
      assert.deepEqual(refs(r.evidence), ['code:C-primary/workaround'])
    })
  })

  describe('idempotency', () => {
    it('adding evidence already present is a clean no-op: no event, no write', () => {
      const before = eventCount(seed)
      const text = readFileSync(themePath, 'utf8')
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-distrust' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, false)
      assert.deepEqual(r.added, [])
      assert.deepEqual(refs(r.already_present), ['code:C-distrust'])
      assert.equal(r.update_event_id, undefined)
      assert.equal(r.file_rewritten, false)
      assert.equal(eventCount(seed), before, 'zero events')
      assert.equal(readFileSync(themePath, 'utf8'), text)
    })

    it('removing evidence already absent is a clean no-op: no event, no write', () => {
      const before = eventCount(seed)
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, false)
      assert.deepEqual(refs(r.not_present), ['code:C-override'])
      assert.deepEqual(refs(r.evidence), ['code:C-distrust'])
      assert.equal(eventCount(seed), before, 'zero events')
    })

    it('repeating a change is a no-op the second time', () => {
      const edit = { add: [{ kind: 'code' as const, ref: 'C-override' }] }
      const first = editThemeEvidence(seed, themeId, edit, RESEARCHER)
      const before = eventCount(seed)
      const second = editThemeEvidence(seed, themeId, edit, RESEARCHER)
      assert.equal(first.changed, true)
      assert.equal(second.changed, false)
      assert.deepEqual(second.evidence, first.evidence)
      assert.equal(eventCount(seed), before)
    })

    it('a mixed call applies the new entries and reports the rest', () => {
      const r = editThemeEvidence(
        seed,
        themeId,
        {
          add: [
            { kind: 'code', ref: 'C-distrust' },
            { kind: 'code', ref: 'C-override' },
          ],
        },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.deepEqual(refs(r.added), ['code:C-primary/override'])
      assert.deepEqual(refs(r.already_present), ['code:C-distrust'])
    })
  })

  describe('bare vs qualified refs are one entry', () => {
    it('a qualified id, a bare id and a name all match the stored bare ref', () => {
      const before = eventCount(seed)
      for (const ref of ['C-primary/distrust', 'C-distrust', 'distrust']) {
        const r = editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref }] }, RESEARCHER)
        assert.equal(r.changed, false, `${ref} is already on the theme`)
        assert.deepEqual(refs(r.already_present), ['code:C-distrust'])
      }
      // …and all three spellings in one call are still that one entry.
      const all = editThemeEvidence(
        seed,
        themeId,
        {
          add: [
            { kind: 'code', ref: 'C-primary/distrust' },
            { kind: 'code', ref: 'C-distrust' },
            { kind: 'code', ref: 'distrust' },
          ],
        },
        RESEARCHER,
      )
      assert.equal(all.changed, false)
      assert.deepEqual(refs(all.already_present), ['code:C-distrust'])
      assert.equal(eventCount(seed), before)
    })

    it('the same code twice in one add lands once', () => {
      const r = editThemeEvidence(
        seed,
        themeId,
        {
          add: [
            { kind: 'code', ref: 'C-override' },
            { kind: 'code', ref: 'C-primary/override' },
            { kind: 'code', ref: 'override' },
          ],
        },
        RESEARCHER,
      )
      assert.deepEqual(refs(r.added), ['code:C-primary/override'])
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'code:C-primary/override'])
    })

    it('a stored bare ref is removed by its qualified id, and vice versa', () => {
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
      // stored: bare C-distrust (from create), qualified C-primary/override (from add)
      const a = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-primary/distrust' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(a.removed), ['code:C-distrust'])
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-distrust' }] }, RESEARCHER)
      const b = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(b.removed), ['code:C-primary/override'])
    })
  })

  describe('refusals carry a code and a fix', () => {
    const untouched = (fn: () => unknown): CompostError => {
      const before = eventCount(seed)
      const text = readFileSync(themePath, 'utf8')
      const err = catchErr(fn)
      assert.equal(eventCount(seed), before, 'a refusal emits no event')
      assert.equal(readFileSync(themePath, 'utf8'), text, 'a refusal leaves the markdown alone')
      return err
    }

    it('unknown theme → FILE_NOT_FOUND, pointing at `compost list theme`', () => {
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          'T-nope',
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'FILE_NOT_FOUND')
      assert.match(err.message, /No theme "T-nope"/)
      assert.match(err.message, /compost list theme --state all/)
    })

    it('archived theme → INVALID_INPUT, pointing at `compost create theme`', () => {
      rejectArtifact(seed, themeId, 'reviewer@example.com')
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /archived \(rejected\)/)
      assert.match(err.message, /compost create theme/)
    })

    it('nothing to add or remove → INVALID_INPUT, showing the --evidence form', () => {
      for (const edit of [{}, { add: [] }, { add: [], remove: [] }]) {
        const err = untouched(() => editThemeEvidence(seed, themeId, edit, RESEARCHER))
        assert.equal(err.code, 'INVALID_INPUT')
        assert.match(err.message, /--evidence kind:ref/)
      }
    })

    it('memo evidence on add → INVALID_INPUT, pointing at `compost memo cite` (ADR 0008 §5)', () => {
      const memo = createMemo(seed, { content: 'a hunch', author: RESEARCHER })
      const err = untouched(() =>
        editThemeEvidence(seed, themeId, { add: [{ kind: 'memo', ref: memo.id }] }, RESEARCHER),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /code or category evidence only/)
      assert.match(err.message, /ADR 0008 §5/)
      assert.match(
        err.message,
        new RegExp(`compost memo cite ${memo.id} --anchor theme:${themeId}`),
      )
    })

    it('unknown code on add → INVALID_INPUT listing the known codes', () => {
      const err = untouched(() =>
        editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-distrst' }] }, RESEARCHER),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /No code "C-distrst"/)
      assert.match(err.message, /Known codes: .*C-primary\/distrust/)
    })

    it('ambiguous bare code on add → INVALID_INPUT listing the qualified candidates', () => {
      createCodebook(seed, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
      createCode(seed, {
        name: 'override',
        definition: 'o2',
        codebookId: 'lens-b',
        author: RESEARCHER,
      })
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /ambiguous across codebooks/)
      assert.match(err.message, /C-primary\/override/)
      assert.match(err.message, /C-lens-b\/override/)
    })

    it('unknown category on add → INVALID_INPUT listing the available ones', () => {
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'category', ref: 'CAT-nope' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /No category "CAT-nope"/)
      assert.match(err.message, /Available: CAT-agency/)
    })

    it('a rejected code cannot be added', () => {
      rejectArtifact(seed, 'C-override', 'reviewer@example.com')
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /No code "C-override"/)
    })

    it('the same entry in add and remove → INVALID_INPUT', () => {
      for (const ref of ['C-override', 'C-distrust']) {
        const err = untouched(() =>
          editThemeEvidence(
            seed,
            themeId,
            { add: [{ kind: 'code', ref }], remove: [{ kind: 'code', ref }] },
            RESEARCHER,
          ),
        )
        assert.equal(err.code, 'INVALID_INPUT')
        assert.match(err.message, /both the add set and the remove set/)
      }
    })

    it('emptying the code/category set → INVALID_INPUT, pointing at `compost reject`', () => {
      const err = untouched(() =>
        editThemeEvidence(
          seed,
          themeId,
          { remove: [{ kind: 'code', ref: 'C-distrust' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /no code or category evidence/)
      assert.match(err.message, new RegExp(`compost reject ${themeId}`))
      assert.match(err.message, new RegExp(`compost theme add ${themeId}`))
    })
  })

  describe('frames: the verb never changes a theme’s lens', () => {
    let crossId: string

    beforeEach(() => {
      createCodebook(seed, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
      createCode(seed, {
        name: 'ritual',
        definition: 'r',
        codebookId: 'lens-b',
        author: RESEARCHER,
      })
      createCode(seed, { name: 'taboo', definition: 't', codebookId: 'lens-b', author: RESEARCHER })
      crossId = createTheme(seed, {
        name: 'spanning',
        summary: 's',
        evidence: [
          { kind: 'code', ref: 'C-distrust' },
          { kind: 'code', ref: 'C-ritual' },
        ],
        codebookId: null,
        author: RESEARCHER,
      }).id
    })

    it('single-lens theme refuses evidence from another codebook', () => {
      const before = eventCount(seed)
      const err = catchErr(() =>
        editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-ritual' }] }, RESEARCHER),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /scoped to CB-primary/)
      assert.match(err.message, /CB-lens-b/)
      assert.match(err.message, /never changes a theme's lens/)
      assert.match(err.message, /compost create theme --cross-lens/)
      assert.doesNotMatch(err.message, /pass --cross-lens/, 'no create-only flag in an edit hint')
      assert.equal(eventCount(seed), before)
      assert.equal(getArtifact(seed, 'theme', themeId)?.current_state.codebook_id, 'CB-primary')
    })

    it('cross-lens theme takes evidence from either of its frames and stays cross-lens', () => {
      const r = editThemeEvidence(
        seed,
        crossId,
        {
          add: [
            { kind: 'code', ref: 'C-override' },
            { kind: 'code', ref: 'C-taboo' },
          ],
        },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.equal(r.codebook_id, null)
      assert.deepEqual(
        r.added.map((e) => e.codebook_id),
        ['CB-primary', 'CB-lens-b'],
      )
      assert.equal(getArtifact(seed, 'theme', crossId)?.current_state.codebook_id, null)
    })

    it('cross-lens theme refuses a removal that leaves a single codebook', () => {
      const before = eventCount(seed)
      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          crossId,
          { remove: [{ kind: 'code', ref: 'C-ritual' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /≥2 codebooks/)
      assert.match(err.message, /after this edit it would all be in CB-primary/)
      assert.match(err.message, /never changes a theme's lens/)
      assert.equal(eventCount(seed), before)
    })

    it('cross-lens theme allows swapping one lens-b code for another in one call', () => {
      const r = editThemeEvidence(
        seed,
        crossId,
        { add: [{ kind: 'code', ref: 'C-taboo' }], remove: [{ kind: 'code', ref: 'C-ritual' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(r.evidence), ['code:C-distrust', 'code:C-lens-b/taboo'])
    })
  })

  describe('provenance and the endorsement gate', () => {
    it('blame shows the update with its actor and the before/after sets', () => {
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
      const lineage = blame(themeId, { cwd: work, seed: 'demo' })
      assert.deepEqual(
        lineage.events.map((e) => e.action),
        ['create', 'update'],
      )
      const update = lineage.events[1]
      assert.equal(update?.actor_type, 'researcher')
      assert.equal(update?.actor_id, 'juan@example.com')
      assert.equal(update?.parent_event, lineage.events[0]?.id)
      const payload = update?.payload as {
        field: string
        before: Array<{ ref: string }>
        after: Array<{ kind: string; ref: string; codebook_id: string }>
      }
      assert.equal(payload.field, 'evidence')
      assert.deepEqual(
        payload.before.map((e) => e.ref),
        ['C-distrust'],
      )
      assert.deepEqual(payload.after, [
        { kind: 'code', ref: 'C-distrust', codebook_id: 'CB-primary' },
        { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
      ])
    })

    it('a researcher editing an AI [draft] does not endorse it', () => {
      const draft = createTheme(seed, {
        name: 'ai-idea',
        summary: 's',
        evidence: [{ kind: 'code', ref: 'C-distrust' }],
        author: AI,
      })
      const r = editThemeEvidence(
        seed,
        draft.id,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.equal(r.state, 'draft')
      const snap = getArtifact(seed, 'theme', draft.id)
      assert.equal(snap?.human_approved, false, 'still awaiting endorsement')
      assert.equal(snap?.current_state._endorsement, undefined)
      assert.equal(listByKind(seed, 'theme', { state: 'draft' }).items[0]?.id, draft.id)
      // …and endorsing afterwards covers the edited set.
      endorseArtifact(seed, draft.id, 'juan@example.com')
      assert.equal(getArtifact(seed, 'theme', draft.id)?.human_approved, true)
    })

    it('an AI actor may edit a theme while it is a draft; the event records the AI', () => {
      const draft = createTheme(seed, {
        name: 'ai-idea',
        summary: 's',
        evidence: [{ kind: 'code', ref: 'C-distrust' }],
        author: AI,
      })
      const r = editThemeEvidence(
        seed,
        draft.id,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        AI,
      )
      assert.equal(r.changed, true)
      assert.equal(r.state, 'draft')
      const last = themeEvents(seed, draft.artifact_id).at(-1)
      assert.equal(last?.action, 'update')
      assert.equal(last?.actor_type, 'ai')
      assert.equal(last?.actor_id, AI.actorId)
      assert.equal(last?.model, AI.model)
      assert.equal(last?.prompt_hash, AI.promptHash)
      assert.equal(getArtifact(seed, 'theme', draft.id)?.human_approved, false)
    })

    it('an AI actor is refused on an endorsed theme — add, remove, and even a no-op', () => {
      const draft = createTheme(seed, {
        name: 'ai-idea',
        summary: 's',
        evidence: [
          { kind: 'code', ref: 'C-distrust' },
          { kind: 'code', ref: 'C-override' },
        ],
        author: AI,
      })
      endorseArtifact(seed, draft.id, 'juan@example.com')
      const before = eventCount(seed)
      const text = readFileSync(draft.path, 'utf8')
      for (const edit of [
        { add: [{ kind: 'code' as const, ref: 'C-workaround' }] },
        { remove: [{ kind: 'code' as const, ref: 'C-override' }] },
        { add: [{ kind: 'code' as const, ref: 'C-distrust' }] }, // would be a no-op
      ]) {
        const err = catchErr(() => editThemeEvidence(seed, draft.id, edit, AI))
        assert.equal(err.code, 'INVALID_INPUT')
        assert.match(err.message, /is endorsed/)
        assert.match(err.message, /only while the theme is still a \[draft\]/)
        assert.match(err.message, /ask them to run `compost theme add\|remove/)
      }
      assert.equal(eventCount(seed), before, 'no event')
      assert.equal(readFileSync(draft.path, 'utf8'), text, 'no write')
      assert.equal(getArtifact(seed, 'theme', draft.id)?.human_approved, true)
    })

    it('an AI actor is refused on a researcher-authored theme (born endorsed)', () => {
      const err = catchErr(() =>
        editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, AI),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /is endorsed/)
      // The researcher can make the same change.
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.state, 'endorsed')
    })
  })

  describe('markdown restamp is atomic with the event', () => {
    it('if the event is rejected, the markdown is untouched and no temp file is left', () => {
      const draft = createTheme(seed, {
        name: 'ai-idea',
        summary: 's',
        evidence: [{ kind: 'code', ref: 'C-distrust' }],
        author: AI,
      })
      const before = eventCount(seed)
      const text = readFileSync(draft.path, 'utf8')
      // An AI event without model + prompt_hash fails the event schema.
      const incomplete: Author = { actorType: 'ai', actorId: 'claude-code:0.2.2:abc12345' }
      // The failure is the event's (so the markdown was already staged by then).
      assert.throws(
        () =>
          editThemeEvidence(
            seed,
            draft.id,
            { add: [{ kind: 'code', ref: 'C-override' }] },
            incomplete,
          ),
        /Event failed schema validation/,
      )
      assert.equal(eventCount(seed), before, 'the event did not land')
      assert.equal(readFileSync(draft.path, 'utf8'), text, 'the markdown was not replaced')
      assert.deepEqual(
        readdirSync(join(seed, 'synthesis', 'themes')).filter((f) => !f.endsWith('.md')),
        [],
        'the staged temp file was removed',
      )
      assert.deepEqual(ledgerEvidence(draft.id), ['code:C-distrust'])
    })

    it('leaves no temp file behind on success', () => {
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
      assert.deepEqual(readdirSync(join(seed, 'synthesis', 'themes')).sort(), ['control.md'])
    })

    it('a theme with no markdown file still gets its event (the ledger carries the truth)', () => {
      rmSync(themePath)
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.equal(r.file_rewritten, false)
      assert.equal(existsSync(themePath), false)
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'code:C-primary/override'])
    })
  })

  describe('readers agree after an edit', () => {
    /** Sessions a theme reaches, per `list theme --evidence` (ledger). */
    const sessionsPerList = (id: string): string[] => {
      const item = listByKind(seed, 'theme', { evidence: true }).items.find((i) => i.id === id)
      assert.ok(item !== undefined)
      const sessions = new Set<string>()
      for (const e of item.evidence as ThemeEvidenceDetail[]) {
        for (const q of e.highlights) if (q.session_id !== null) sessions.add(q.session_id)
      }
      return [...sessions].sort()
    }
    /** Sessions a theme reaches, per `saturate` (markdown frontmatter). */
    const sessionsPerSaturate = (id: string): string[] =>
      gatherSessionsWithThemes({ cwd: work, seed: 'demo' })
        .filter((s) => s.themes.includes(id))
        .map((s) => s.id)

    it('`list theme --evidence` and `saturate` agree after add and after remove', () => {
      for (const s of ['S001', 'S002', 'S003']) mkdirSync(join(seed, 'sessions', s))
      const hl = (sessionId: string, text: string): string =>
        createHighlight(seed, {
          sessionId,
          utteranceId: 'U-0001',
          span: [0, text.length],
          text,
          author: RESEARCHER,
        }).id
      const h1 = hl('S001', 'no confío')
      const h2 = hl('S002', 'lo hago a mano')
      const h3 = hl('S003', 'prefiero decidir yo')
      createCode(seed, { name: 'doubt', definition: 'd', evidence: [h1], author: RESEARCHER })
      createCode(seed, { name: 'manual', definition: 'm', evidence: [h2], author: RESEARCHER })
      createCode(seed, { name: 'decide', definition: 'x', evidence: [h3], author: RESEARCHER })
      createCategory(seed, { name: 'autonomy', definition: 'a', author: RESEARCHER })
      linkCodeToCategory(seed, { code: 'C-decide', category: 'CAT-autonomy', author: RESEARCHER })
      const t = createTheme(seed, {
        name: 'hands-on',
        summary: 's',
        evidence: [{ kind: 'code', ref: 'C-doubt' }],
        author: RESEARCHER,
      }).id
      assert.deepEqual(sessionsPerList(t), ['S001'])
      assert.deepEqual(sessionsPerSaturate(t), ['S001'])

      // add a code and a category
      editThemeEvidence(
        seed,
        t,
        {
          add: [
            { kind: 'code', ref: 'C-manual' },
            { kind: 'category', ref: 'CAT-autonomy' },
          ],
        },
        RESEARCHER,
      )
      assert.deepEqual(sessionsPerList(t), ['S001', 'S002', 'S003'])
      assert.deepEqual(sessionsPerSaturate(t), ['S001', 'S002', 'S003'])

      // remove the original code
      editThemeEvidence(seed, t, { remove: [{ kind: 'code', ref: 'C-doubt' }] }, RESEARCHER)
      assert.deepEqual(sessionsPerList(t), ['S002', 'S003'])
      assert.deepEqual(sessionsPerSaturate(t), ['S002', 'S003'])

      // remove the category
      editThemeEvidence(seed, t, { remove: [{ kind: 'category', ref: 'autonomy' }] }, RESEARCHER)
      assert.deepEqual(sessionsPerList(t), ['S002'])
      assert.deepEqual(sessionsPerSaturate(t), ['S002'])
    })

    it('reindex reproduces the edited state from the ledger alone', () => {
      editThemeEvidence(
        seed,
        themeId,
        {
          add: [
            { kind: 'code', ref: 'C-override' },
            { kind: 'category', ref: 'CAT-agency' },
          ],
        },
        RESEARCHER,
      )
      editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-distrust' }] },
        RESEARCHER,
      )
      const live = getArtifact(seed, 'theme', themeId)
      assert.ok(live !== null)

      // What `compost reindex` does: rebuild every snapshot from the events.
      const db = new Database(eventsDbPath(seed))
      let rebuilt: ReturnType<SnapshotStore['get']>
      try {
        const store = new SnapshotStore(db)
        store.rebuildAll()
        rebuilt = store.get('theme', themeSha)
      } finally {
        db.close()
      }
      assert.ok(rebuilt !== null)
      assert.deepEqual(rebuilt.current_state, live.current_state)
      assert.equal(rebuilt.version, 3) // create + 2 updates
      assert.equal(rebuilt.human_approved, true)
      assert.deepEqual(rebuilt.current_state.evidence, [
        { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
        { kind: 'category', ref: 'CAT-agency', codebook_id: 'CB-primary' },
      ])
      // …and the markdown is that same set, so it derives from the ledger.
      const fm = frontmatterOf(themePath)
      assert.deepEqual(
        refs(loadThemeEvidence({ ...(fm.evidence ? { evidence: fm.evidence } : {}) })),
        refs(themeEvidenceFromState(rebuilt.current_state)),
      )
    })
  })

  describe('existing shapes', () => {
    it('edits a legacy codes[]-only theme (pre-#266), stamping frames as it goes', () => {
      // A theme as it was written before evidence[] existed: `codes` in the
      // create payload and in the frontmatter, no `evidence`, no `codebook_id`.
      const initialState = {
        id: 'T-legacy',
        kind: 'theme',
        name: 'legacy',
        summary: 's',
        codes: ['C-distrust'],
      }
      const events = openSeedEvents(seed)
      try {
        emitCreate(events, { artifactKind: 'theme', initialState, author: RESEARCHER })
      } finally {
        events.close()
      }
      const path = join(seed, 'synthesis', 'themes', 'legacy.md')
      writeFileSync(path, '---\nid: T-legacy\nname: legacy\ncodes: [C-distrust]\n---\n\n# legacy\n')

      const r = editThemeEvidence(
        seed,
        'T-legacy',
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.deepEqual(r.evidence, [
        { kind: 'code', ref: 'C-distrust', codebook_id: 'CB-primary' },
        { kind: 'code', ref: 'C-primary/override', codebook_id: 'CB-primary' },
      ])
      assert.equal(
        readFileSync(path, 'utf8'),
        '---\nid: T-legacy\nname: legacy\nevidence: [code:C-distrust:CB-primary, code:C-primary/override:CB-primary]\ncodes: [C-distrust, C-primary/override]\n---\n\n# legacy\n',
      )
      // The already-present check reads the legacy codes too.
      const again = editThemeEvidence(
        seed,
        'T-legacy',
        { add: [{ kind: 'code', ref: 'C-distrust' }] },
        RESEARCHER,
      )
      assert.equal(again.changed, false)
    })

    it('a memo entry already on a theme can be removed, and its absence leaves frames alone', () => {
      const memo = createMemo(seed, { content: 'a hunch', author: RESEARCHER })
      const t = createTheme(seed, {
        name: 'with-memo',
        summary: 's',
        evidence: [
          { kind: 'code', ref: 'C-distrust' },
          { kind: 'memo', ref: memo.id },
        ],
        author: RESEARCHER,
      })
      const r = editThemeEvidence(
        seed,
        t.id,
        { remove: [{ kind: 'memo', ref: memo.id }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.deepEqual(refs(r.removed), [`memo:${memo.id}`])
      assert.deepEqual(refs(r.evidence), ['code:C-distrust'])
      assert.deepEqual(frontmatterOf(t.path).codes, ['C-distrust'])
    })

    it('a memo does not count as the last evidence: removing the only code is still refused', () => {
      const memo = createMemo(seed, { content: 'a hunch', author: RESEARCHER })
      const t = createTheme(seed, {
        name: 'with-memo',
        summary: 's',
        evidence: [
          { kind: 'code', ref: 'C-distrust' },
          { kind: 'memo', ref: memo.id },
        ],
        author: RESEARCHER,
      })
      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          t.id,
          { remove: [{ kind: 'code', ref: 'C-distrust' }] },
          RESEARCHER,
        ),
      )
      assert.match(err.message, /no code or category evidence/)
    })

    it('evidence whose code was since rejected is removable by its stored ref', () => {
      editThemeEvidence(seed, themeId, { add: [{ kind: 'code', ref: 'C-override' }] }, RESEARCHER)
      rejectArtifact(seed, 'C-primary/override', 'reviewer@example.com')
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-primary/override' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(r.removed), ['code:C-primary/override'])
    })

    // Known edge, recorded rather than special-cased (it waits on the
    // maintainer): `create theme` with no evidence stores codebook_id null,
    // which the ledger cannot tell apart from "cross-lens". Giving such a theme
    // its first lens would be the verb choosing a frame, so the rule applied is
    // unchanged — but the refusal must say what happened, not tell a
    // single-codebook researcher to go find a second lens.
    it('a theme created with no evidence is refused a single-codebook add, honestly', () => {
      createCodebook(seed, { name: 'lens-b', stance: 'deductive', author: RESEARCHER })
      createCode(seed, {
        name: 'ritual',
        definition: 'r',
        codebookId: 'lens-b',
        author: RESEARCHER,
      })
      const bare = createTheme(seed, { name: 'bare', summary: 's', author: RESEARCHER })
      assert.equal(getArtifact(seed, 'theme', bare.id)?.current_state.codebook_id, null)

      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          bare.id,
          { add: [{ kind: 'code', ref: 'C-distrust' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      // What happened: no lens was ever recorded, and the verb will not pick one.
      assert.match(err.message, /has no lens: it was created without code or category evidence/)
      assert.match(err.message, /never picks a lens/)
      assert.match(err.message, /all in CB-primary/)
      // The two workable paths: re-create it scoped, or go cross-lens in one call.
      assert.match(err.message, /compost create theme .*--codebook CB-primary/)
      assert.match(err.message, /compost reject/)
      assert.match(err.message, /add evidence from ≥2 codebooks in one call/)
      // It must not read as "this is a cross-lens theme, add a second codebook".
      assert.doesNotMatch(err.message, /A cross-lens theme must cite/)
      assert.doesNotMatch(err.message, /keep \(or add, in the same call\)/)

      const r = editThemeEvidence(
        seed,
        bare.id,
        {
          add: [
            { kind: 'code', ref: 'C-distrust' },
            { kind: 'code', ref: 'C-ritual' },
          ],
        },
        RESEARCHER,
      )
      assert.equal(r.changed, true)
      assert.equal(r.codebook_id, null)

      // Once it has evidence it is an ordinary cross-lens theme, and says so.
      const later = catchErr(() =>
        editThemeEvidence(
          seed,
          bare.id,
          { remove: [{ kind: 'code', ref: 'C-ritual' }] },
          RESEARCHER,
        ),
      )
      assert.match(later.message, /A cross-lens theme must cite evidence from ≥2 codebooks/)
    })
  })

  describe('review fixes: concurrency (optimistic, on the snapshot that was read)', () => {
    const themesDir = () => join(seed, 'synthesis', 'themes')
    const strayFiles = (): string[] => readdirSync(themesDir()).filter((f) => !f.endsWith('.md'))

    it('an endorse landing between the gate and the write refuses the AI edit', () => {
      const draft = createTheme(seed, {
        name: 'ai-idea',
        summary: 's',
        evidence: [{ kind: 'code', ref: 'C-distrust' }],
        author: AI,
      })
      const text = readFileSync(draft.path, 'utf8')
      // The AI's edit passes the gate (the theme is a draft)… and then the
      // researcher endorses before its event is written.
      const err = catchErr(() =>
        editThemeEvidence(seed, draft.id, { add: [{ kind: 'code', ref: 'C-override' }] }, AI, {
          beforeWrite: () => endorseArtifact(seed, draft.id, 'juan@example.com'),
        }),
      )
      assert.equal(err.code, 'CONFLICT')
      assert.match(err.message, /changed while this edit was being prepared/)
      assert.match(err.message, /Nothing was written/)
      assert.match(err.message, new RegExp(`Re-run \`compost theme add\\|remove ${draft.id}`))

      // No AI update rode in behind the endorsement: no event, no write.
      assert.deepEqual(
        themeEvents(seed, draft.artifact_id).map((e) => `${e.action}/${e.actor_type}`),
        ['create/ai', 'endorse/researcher'],
      )
      assert.equal(readFileSync(draft.path, 'utf8'), text)
      assert.deepEqual(strayFiles(), [], 'the staged temp file was removed')
      assert.deepEqual(ledgerEvidence(draft.id), ['code:C-distrust'])

      // Re-running, as the message says, now meets the gate.
      const again = catchErr(() =>
        editThemeEvidence(seed, draft.id, { add: [{ kind: 'code', ref: 'C-override' }] }, AI),
      )
      assert.equal(again.code, 'INVALID_INPUT')
      assert.match(again.message, /is endorsed/)
    })

    it('a reject landing in between refuses the edit too', () => {
      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
          { beforeWrite: () => rejectArtifact(seed, themeId, 'reviewer@example.com') },
        ),
      )
      assert.equal(err.code, 'CONFLICT')
      assert.deepEqual(
        themeEvents(seed, themeSha).map((e) => e.action),
        ['create', 'reject'],
      )
    })

    it('two edits from the same snapshot: the second is a CONFLICT, not a lost update', () => {
      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          themeId,
          { add: [{ kind: 'code', ref: 'C-override' }] },
          RESEARCHER,
          {
            // Another researcher edit, read from the same state, lands first.
            beforeWrite: () => {
              editThemeEvidence(
                seed,
                themeId,
                { add: [{ kind: 'code', ref: 'C-workaround' }] },
                RESEARCHER,
              )
            },
          },
        ),
      )
      assert.equal(err.code, 'CONFLICT')
      // Exactly the winner's event; ledger and markdown agree on its set.
      assert.equal(themeEvents(seed, themeSha).length, 2)
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust', 'code:C-primary/workaround'])
      assert.deepEqual(frontmatterOf(themePath).evidence, [
        'code:C-distrust:CB-primary',
        'code:C-primary/workaround:CB-primary',
      ])
      assert.deepEqual(strayFiles(), [])

      // Re-running applies on top of the winner: nothing is lost.
      const again = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(again.evidence), [
        'code:C-distrust',
        'code:C-primary/workaround',
        'code:C-primary/override',
      ])
      const events = themeEvents(seed, themeSha)
      const last = JSON.parse(events.at(-1)?.payload ?? '{}') as { before: unknown[] }
      assert.equal(last.before.length, 2, 'its `before` is the winner’s set, not the stale one')
    })

    it('a later edit that commits before our rename is not overwritten on disk', () => {
      // Ours commits; before our markdown is renamed, a second edit (which read
      // our committed state) commits AND renames. Our rename must not put the
      // older set back.
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
        {
          afterEvent: () => {
            editThemeEvidence(
              seed,
              themeId,
              { add: [{ kind: 'code', ref: 'C-workaround' }] },
              RESEARCHER,
            )
          },
        },
      )
      assert.equal(r.changed, true)
      const all = ['code:C-distrust', 'code:C-primary/override', 'code:C-primary/workaround']
      assert.deepEqual(ledgerEvidence(), all)
      assert.deepEqual(
        refs(loadThemeEvidence({ evidence: frontmatterOf(themePath).evidence ?? [] })),
        all,
        'the markdown is the ledger’s current set',
      )
      assert.deepEqual(strayFiles(), [])
    })

    it('updateArtifact: expectedParent makes the write conditional; omitted, it is not', () => {
      const snap = getArtifact(seed, 'theme', themeId)
      assert.ok(snap !== null)
      const stale = snap.last_event
      const first = updateArtifact(
        seed,
        themeId,
        { field: 'summary', before: 's', after: 'one' },
        RESEARCHER,
        { expectedParent: stale },
      )
      assert.equal(first.parent_event_id, stale)

      const before = eventCount(seed)
      const err = catchErr(() =>
        updateArtifact(seed, themeId, { field: 'summary', after: 'two' }, RESEARCHER, {
          expectedParent: stale,
        }),
      )
      assert.equal(err.code, 'CONFLICT')
      assert.match(err.message, /changed since it was read/)
      assert.match(err.message, /re-run/)
      assert.equal(eventCount(seed), before, 'nothing was written')
      assert.equal(getArtifact(seed, 'theme', themeId)?.current_state.summary, 'one')

      // Without expectedParent the call is unconditional, as it always was.
      const third = updateArtifact(seed, themeId, { field: 'summary', after: 'three' }, RESEARCHER)
      assert.equal(third.parent_event_id, first.update_event_id)
    })
  })

  describe('review fixes: a bare ref that became ambiguous', () => {
    // The theme stores the bare `C-distrust` (as `create theme` wrote it, with
    // its frame CB-primary). Duplicating the codebook makes that bare ref
    // ambiguous: C-primary/distrust and C-copy/distrust.
    beforeEach(() => {
      duplicateCodebook(seed, 'primary', 'copy', 'juan@example.com')
      assert.equal(
        getArtifact(seed, 'code', 'C-copy/distrust')?.current_state.id,
        'C-copy/distrust',
        'the duplicate holds the same slug',
      )
    })

    it('adding the qualified id of a stored bare ref is already_present, not a duplicate', () => {
      const before = eventCount(seed)
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-primary/distrust' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, false)
      assert.deepEqual(refs(r.already_present), ['code:C-distrust'])
      assert.deepEqual(ledgerEvidence(), ['code:C-distrust'])
      assert.equal(eventCount(seed), before)
    })

    it('removing by the ambiguous bare ref is refused with the resolver’s error', () => {
      editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-primary/override' }] },
        RESEARCHER,
      )
      const before = eventCount(seed)
      const err = catchErr(() =>
        editThemeEvidence(
          seed,
          themeId,
          { remove: [{ kind: 'code', ref: 'C-distrust' }] },
          RESEARCHER,
        ),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /Code "C-distrust" is ambiguous across codebooks/)
      assert.match(err.message, /C-primary\/distrust/)
      assert.match(err.message, /C-copy\/distrust/)
      assert.match(err.message, /Qualify it as C-<codebook>\/<code>/)
      assert.equal(eventCount(seed), before)

      // Qualified, it removes the stored bare entry (its frame picks it out)…
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-primary/distrust' }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(r.removed), ['code:C-distrust'])
      // …and the other frame's same-named code was never on the theme.
      const other = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-copy/distrust' }] },
        RESEARCHER,
      )
      assert.equal(other.changed, false)
      assert.deepEqual(refs(other.not_present), ['code:C-copy/distrust'])
    })

    it('an unknown ref on remove is still tolerated (not_present)', () => {
      const r = editThemeEvidence(
        seed,
        themeId,
        { remove: [{ kind: 'code', ref: 'C-never-existed' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, false)
      assert.deepEqual(refs(r.not_present), ['code:C-never-existed'])
    })
  })

  describe('review fixes: reporting and the empty set', () => {
    it('warns when the markdown exists but could not be restamped (CRLF frontmatter)', () => {
      const crlf = readFileSync(themePath, 'utf8').replace(/\n/g, '\r\n')
      writeFileSync(themePath, crlf)
      const r = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(r.changed, true, 'the ledger is still updated')
      assert.equal(r.file_rewritten, false)
      assert.ok(r.warning !== undefined)
      assert.match(r.warning, /was NOT restamped/)
      assert.match(r.warning, /control\.md/)
      assert.match(
        r.warning,
        /evidence: \[code:C-distrust:CB-primary, code:C-primary\/override:CB-primary\]/,
      )
      assert.equal(readFileSync(themePath, 'utf8'), crlf, 'the file was left alone')
      assert.deepEqual(readdirSync(join(seed, 'synthesis', 'themes')), ['control.md'])
    })

    it('does not warn when there is simply no markdown file, or on a normal restamp', () => {
      const ok = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(ok.warning, undefined)
      rmSync(themePath)
      const gone = editThemeEvidence(
        seed,
        themeId,
        { add: [{ kind: 'code', ref: 'C-workaround' }] },
        RESEARCHER,
      )
      assert.equal(gone.file_rewritten, false)
      assert.equal(gone.warning, undefined)
    })

    it('reports the inferred codebook for a legacy codes[] theme, changed or not', () => {
      const initialState = {
        id: 'T-legacy',
        kind: 'theme',
        name: 'legacy',
        summary: 's',
        codes: ['C-distrust'],
      }
      const events = openSeedEvents(seed)
      try {
        emitCreate(events, { artifactKind: 'theme', initialState, author: RESEARCHER })
      } finally {
        events.close()
      }
      const noop = editThemeEvidence(
        seed,
        'T-legacy',
        { add: [{ kind: 'code', ref: 'C-distrust' }] },
        RESEARCHER,
      )
      assert.equal(noop.changed, false)
      assert.equal(noop.codebook_id, 'CB-primary')
      const changed = editThemeEvidence(
        seed,
        'T-legacy',
        { add: [{ kind: 'code', ref: 'C-override' }] },
        RESEARCHER,
      )
      assert.equal(changed.changed, true)
      assert.equal(changed.codebook_id, 'CB-primary')
    })

    it('a memo-only theme cannot be emptied either; one of two memos can go', () => {
      const m1 = createMemo(seed, { content: 'one', author: RESEARCHER })
      const m2 = createMemo(seed, { content: 'two', author: RESEARCHER })
      const t = createTheme(seed, {
        name: 'memos-only',
        summary: 's',
        evidence: [
          { kind: 'memo', ref: m1.id },
          { kind: 'memo', ref: m2.id },
        ],
        author: RESEARCHER,
      })
      const one = editThemeEvidence(
        seed,
        t.id,
        { remove: [{ kind: 'memo', ref: m1.id }] },
        RESEARCHER,
      )
      assert.deepEqual(refs(one.evidence), [`memo:${m2.id}`])

      const before = eventCount(seed)
      const err = catchErr(() =>
        editThemeEvidence(seed, t.id, { remove: [{ kind: 'memo', ref: m2.id }] }, RESEARCHER),
      )
      assert.equal(err.code, 'INVALID_INPUT')
      assert.match(err.message, /no evidence at all/)
      assert.match(err.message, new RegExp(`compost reject ${t.id}`))
      assert.match(err.message, new RegExp(`compost theme add ${t.id}`))
      assert.equal(eventCount(seed), before)
    })
  })
})

describe('restampEvidence', () => {
  const EV = [
    { kind: 'code' as const, ref: 'C-a', codebookId: 'CB-primary' },
    { kind: 'category' as const, ref: 'CAT-b', codebookId: 'CB-primary' },
  ]

  it('replaces evidence in place and drops codes once a category is cited', () => {
    const text =
      '---\nid: T-x\nname: x\nevidence: [code:C-a:CB-primary]\ncodes: [C-a]\ncodebook_id: CB-primary\nartifact_id: abc\n---\n\n# X\n\nbody\n'
    assert.equal(
      restampEvidence(text, 'T-x', EV),
      '---\nid: T-x\nname: x\nevidence: [code:C-a:CB-primary, category:CAT-b:CB-primary]\ncodebook_id: CB-primary\nartifact_id: abc\n---\n\n# X\n\nbody\n',
    )
  })

  it('writes an empty set as [] (and an empty legacy codes[])', () => {
    const text = '---\nid: T-x\nevidence: [memo:M-001:]\n---\nbody\n'
    assert.equal(
      restampEvidence(text, 'T-x', []),
      '---\nid: T-x\nevidence: []\ncodes: []\n---\nbody\n',
    )
  })

  it('leaves a body that merely looks like frontmatter alone', () => {
    const text = '---\nid: T-x\nevidence: [code:C-a:CB-primary]\n---\n\nevidence: not frontmatter\n'
    const out = restampEvidence(text, 'T-x', [EV[0] as (typeof EV)[number]])
    assert.ok(out?.endsWith('\n---\n\nevidence: not frontmatter\n'))
  })

  it('returns null when there is no frontmatter, or the file is another theme’s', () => {
    assert.equal(restampEvidence('# just a note\n', 'T-x', EV), null)
    assert.equal(restampEvidence('---\nid: T-other\nevidence: []\n---\n', 'T-x', EV), null)
    assert.equal(restampEvidence('---\nid: T-x\nevidence: []\n', 'T-x', EV), null)
  })
})
