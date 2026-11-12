import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'

import { CompostError } from '../errors.js'
import {
  createCode,
  createCodebook,
  createHighlight,
  createTheme,
  endorseArtifact,
  rejectArtifact,
} from './artifacts.js'
import { countByState, type EvidenceQuote, listByKind, type ThemeEvidenceDetail } from './list.js'
import { STATUS_SCHEMA } from './schemas.generated.js'
import { initSeed } from './seed.js'
import { gatherStatus } from './status.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.2.2:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

function catchErr(fn: () => unknown): CompostError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof CompostError)
    return err
  }
  assert.fail('expected a CompostError')
}

describe('listByKind (ADR 0007 P2)', () => {
  let work: string
  let seed: string
  let hl: string
  let aiCode: string
  let humanCode: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-list-'))
    seed = initSeed('demo', { cwd: work }).path
    hl = createHighlight(seed, {
      sessionId: 'S001',
      utteranceId: 'U-0002',
      span: [0, 16],
      text: 'No sé si confiar',
      author: RESEARCHER,
    }).id
    aiCode = createCode(seed, {
      name: 'distrust',
      definition: 'Doubt about automation',
      evidence: [hl],
      author: AI,
    }).id
    humanCode = createCode(seed, {
      name: 'override',
      definition: 'Wants control',
      author: RESEARCHER,
    }).id
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('default lists draft + endorsed with author, timestamps and state', () => {
    const r = listByKind(seed, 'code')
    assert.equal(r.kind, 'code')
    assert.equal(r.state, 'active')
    assert.equal(r.count, 2)
    const draft = r.items.find((i) => i.id === aiCode)
    const human = r.items.find((i) => i.id === humanCode)
    assert.equal(draft?.state, 'draft')
    assert.equal(draft?.label, 'distrust')
    assert.deepEqual(draft?.author, { actor_type: 'ai', actor_id: AI.actorId })
    assert.equal(draft?.endorsement, null)
    assert.equal(draft?.codebook_id, 'CB-primary')
    assert.ok(!Number.isNaN(Date.parse(draft?.created_at ?? '')))
    assert.ok(!Number.isNaN(Date.parse(draft?.updated_at ?? '')))
    assert.equal(draft?.artifact_id.length, 64)
    assert.equal(human?.state, 'endorsed')
    assert.equal(human?.endorsement?.basis, 'researcher_authored')
    assert.equal(human?.endorsement?.by, 'juan@example.com')
  })

  it('--state draft answers "what is awaiting endorsement?"', () => {
    assert.deepEqual(
      listByKind(seed, 'code', { state: 'draft' }).items.map((i) => i.id),
      [aiCode],
    )
    endorseArtifact(seed, aiCode, 'ana@example.com')
    assert.equal(listByKind(seed, 'code', { state: 'draft' }).count, 0)
    const endorsed = listByKind(seed, 'code', { state: 'endorsed' }).items.find(
      (i) => i.id === aiCode,
    )
    assert.equal(endorsed?.endorsement?.basis, 'endorsed')
    assert.equal(endorsed?.endorsement?.by, 'ana@example.com')
  })

  it('a rejected artifact leaves the default list and shows under archived / all', () => {
    rejectArtifact(seed, aiCode, 'ana@example.com', 'too broad')
    assert.deepEqual(
      listByKind(seed, 'code').items.map((i) => i.id),
      [humanCode],
    )
    const archived = listByKind(seed, 'code', { state: 'archived' }).items
    assert.equal(archived.length, 1)
    assert.equal(archived[0]?.state, 'archived')
    assert.equal(archived[0]?.archive?.by, 'ana@example.com')
    assert.equal(archived[0]?.archive?.note, 'too broad')
    assert.equal(listByKind(seed, 'code', { state: 'all' }).count, 2)
  })

  it('--evidence expands a code to its highlight quotes', () => {
    const r = listByKind(seed, 'code', { evidence: true })
    const ev = r.items.find((i) => i.id === aiCode)?.evidence as EvidenceQuote[]
    assert.deepEqual(ev, [
      {
        id: hl,
        quote: 'No sé si confiar',
        session_id: 'S001',
        utterance_id: 'U-0002',
        state: 'endorsed',
      },
    ])
    // Without the flag, no evidence key at all.
    assert.equal(listByKind(seed, 'code').items[0]?.evidence, undefined)
  })

  it('--evidence expands a theme to its evidence set with quotes', () => {
    const theme = createTheme(seed, {
      name: 'control earns trust',
      summary: 's',
      codes: [aiCode, humanCode],
      author: AI,
    })
    const r = listByKind(seed, 'theme', { evidence: true })
    assert.equal(r.count, 1)
    const item = r.items[0]
    assert.equal(item?.id, theme.id)
    assert.equal(item?.state, 'draft')
    assert.equal(item?.summary, 's')
    const ev = item?.evidence as ThemeEvidenceDetail[]
    assert.equal(ev.length, 2)
    const distrust = ev.find((e) => e.ref === aiCode)
    assert.equal(distrust?.kind, 'code')
    assert.deepEqual(distrust?.codes, [aiCode])
    assert.equal(distrust?.highlights[0]?.quote, 'No sé si confiar')
    assert.equal(distrust?.highlights[0]?.session_id, 'S001')
    assert.deepEqual(ev.find((e) => e.ref === humanCode)?.highlights, [])
  })

  it('--codebook scopes codes to one frame', () => {
    createCodebook(seed, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    const framed = createCode(seed, {
      name: 'standpoint',
      definition: 'd',
      codebookId: 'epistemology',
      author: AI,
    }).id
    const r = listByKind(seed, 'code', { codebook: 'epistemology' })
    assert.equal(r.codebook, 'CB-epistemology')
    assert.deepEqual(
      r.items.map((i) => i.id),
      [framed],
    )
    assert.equal(listByKind(seed, 'code', { codebook: 'CB-primary' }).count, 2)
  })

  it('lists highlights with their session / utterance', () => {
    const r = listByKind(seed, 'highlight')
    assert.equal(r.items[0]?.label, 'No sé si confiar')
    assert.equal(r.items[0]?.session_id, 'S001')
    assert.equal(r.items[0]?.utterance_id, 'U-0002')
  })

  it('surfaces markdown with no ledger record as file_only, not as an item', () => {
    mkdirSync(join(seed, 'highlights'), { recursive: true })
    writeFileSync(
      join(seed, 'highlights', 'H-900.md'),
      '---\nid: H-900\nsession_id: S009\nutterance_id: U-0001\n---\nhand-written\n',
    )
    const r = listByKind(seed, 'highlight')
    assert.equal(r.count, 1)
    assert.deepEqual(r.file_only, [{ id: 'H-900', path: join('highlights', 'H-900.md') }])
  })

  it('refuses kinds and flags outside the constrained sets, saying how to fix it', () => {
    const memo = catchErr(() => listByKind(seed, 'memo'))
    assert.equal(memo.code, 'INVALID_INPUT')
    assert.match(memo.message, /compost memo list/)
    assert.match(catchErr(() => listByKind(seed, 'insight')).message, /highlight, code, theme/)
    assert.match(
      catchErr(() => listByKind(seed, 'highlight', { codebook: 'primary' })).message,
      /code and theme only/,
    )
    assert.match(
      catchErr(() => listByKind(seed, 'highlight', { evidence: true })).message,
      /code and theme only/,
    )
    assert.match(
      catchErr(() => listByKind(seed, 'code', { codebook: 'nope' })).message,
      /No codebook "CB-nope"/,
    )
  })

  it('an empty seed (no ledger yet) lists nothing', () => {
    const empty = initSeed('empty', { cwd: work }).path
    const r = listByKind(empty, 'code')
    assert.equal(r.count, 0)
    assert.deepEqual(r.items, [])
  })
})

describe('status by_state (ADR 0007 P2)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-status-state-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('adds a per-kind draft / endorsed / archived split; integer counts unchanged', () => {
    const seed = initSeed('demo', { cwd: work }).path
    const a = createCode(seed, { name: 'a', definition: 'd', author: AI }).id
    createCode(seed, { name: 'b', definition: 'd', author: AI })
    createCode(seed, { name: 'c', definition: 'd', author: RESEARCHER })
    rejectArtifact(seed, a, 'ana@example.com')
    const s = gatherStatus({ cwd: work, seed: 'demo' }).seeds[0]
    assert.ok(s)
    assert.equal(s.counts.codes, 3, 'counts stays an integer (markdown files)')
    assert.equal(typeof s.counts.highlights, 'number')
    assert.deepEqual(s.by_state.codes, { draft: 1, endorsed: 1, archived: 1 })
    assert.deepEqual(s.by_state.highlights, { draft: 0, endorsed: 0, archived: 0 })
    assert.deepEqual(s.by_state.themes, { draft: 0, endorsed: 0, archived: 0 })
    assert.deepEqual(s.by_state.memos, { draft: 0, endorsed: 0, archived: 0 })
    assert.deepEqual(countByState(seed, 'code'), s.by_state.codes)
  })

  it('the full status snapshot validates against schema/status.schema.json', () => {
    const seed = initSeed('demo', { cwd: work }).path
    createCode(seed, { name: 'a', definition: 'd', author: AI })
    const addFormats =
      (addFormatsImport as unknown as { default?: (a: Ajv2020) => Ajv2020 }).default ??
      (addFormatsImport as unknown as (a: Ajv2020) => Ajv2020)
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    const validate = ajv.compile(STATUS_SCHEMA)
    const snapshot = gatherStatus({ cwd: work })
    assert.ok(validate(snapshot), JSON.stringify(validate.errors))
  })
})
