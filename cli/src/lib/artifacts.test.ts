import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import {
  createCode,
  createCodebook,
  createHighlight,
  createTheme,
  endorseArtifact,
  rejectArtifact,
} from './artifacts.js'
import { blame } from './blame.js'
import type { Author } from './events.js'
import { initSeed } from './seed.js'

const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
const AI = {
  actorType: 'ai' as const,
  actorId: 'claude-code:0.1.0:abc12345',
  model: 'anthropic:claude',
  promptHash: 'f'.repeat(64),
}

describe('createHighlight', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('writes H-NNN markdown with dual id + artifact_id and emits a create event', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0002',
      span: [0, 16],
      text: 'No sé si confiar',
      author: RESEARCHER,
    })
    assert.equal(created.id, 'H-001')
    assert.equal(created.artifact_id.length, 64)
    assert.ok(created.path.endsWith('highlights/H-001.md'))

    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /id: H-001/)
    assert.match(md, new RegExp(`artifact_id: ${created.artifact_id}`))
    assert.match(md, /actor_type: researcher/)
    assert.match(md, /No sé si confiar/)

    // blame finds the create event by the SHA artifact_id
    const result = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0]?.action, 'create')
    assert.equal(result.events[0]?.actor_type, 'researcher')
  })

  it('allocates incrementing ids across calls', () => {
    const { path } = initSeed('demo', { cwd: work })
    const a = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 1],
      text: 'a',
      author: RESEARCHER,
    })
    const b = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-2',
      span: [0, 1],
      text: 'b',
      author: RESEARCHER,
    })
    assert.equal(a.id, 'H-001')
    assert.equal(b.id, 'H-002')
  })

  it('records AI authorship (model + prompt_hash) for --ai creates', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-0002',
      span: [0, 5],
      text: 'hello',
      author: AI,
    })
    const result = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    const evt = result.events[0]
    assert.ok(evt)
    assert.equal(evt.actor_type, 'ai')
    assert.equal(evt.actor_id, 'claude-code:0.1.0:abc12345')
    assert.equal(evt.model, 'anthropic:claude')
    assert.equal(evt.prompt_hash, 'f'.repeat(64))
  })
})

describe('createCode / createTheme', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('slugifies code name into C-slug id + filename', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, {
      name: 'Distrust of Automation',
      definition: 'Doubt about acting on alerts.',
      evidence: ['H-001'],
      author: RESEARCHER,
    })
    assert.equal(created.id, 'C-primary/distrust-of-automation')
    assert.ok(created.path.endsWith('codebook/primary/distrust-of-automation.md'))
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /evidence: \[H-001\]/)
  })

  it('refuses to overwrite an existing code', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'dup', definition: 'x', author: RESEARCHER })
    assert.throws(
      () => createCode(path, { name: 'dup', definition: 'y', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })

  it('creates a theme with a title heading and codes list', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createTheme(path, {
      name: 'Control earns trust',
      summary: 'Trust rises with manual override.',
      codes: ['C-distrust', 'C-override'],
      author: RESEARCHER,
    })
    assert.equal(created.id, 'T-control-earns-trust')
    const md = readFileSync(created.path, 'utf8')
    assert.match(md, /# Control earns trust/)
    assert.match(md, /codes: \[C-distrust, C-override\]/)
  })

  it('rejects a name with no slug-able characters', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () => createCode(path, { name: '!!!', definition: 'x', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })
})

describe('in-vivo code-name enforcement (#268)', () => {
  let work: string
  let path: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-invivo-'))
    path = initSeed('demo', { cwd: work }).path
    createCodebook(path, { name: 'voices', stance: 'in_vivo', author: RESEARCHER })
    createHighlight(path, {
      sessionId: 'S001',
      utteranceId: 'U-1',
      span: [0, 40],
      text: 'we are answerable for what we learn how to see',
      author: RESEARCHER,
    }) // → H-001
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('accepts an in_vivo code whose name appears verbatim in its evidence', () => {
    const created = createCode(path, {
      name: 'answerable for what we learn how to see',
      definition: 'accountability over agreement',
      evidence: ['H-001'],
      codebookId: 'voices',
      author: RESEARCHER,
    })
    assert.equal(created.id, 'C-voices/answerable-for-what-we-learn-how-to-see')
  })

  it('matches verbatim case-insensitively / whitespace-normalized', () => {
    assert.doesNotThrow(() =>
      createCode(path, {
        name: 'Answerable   For What We Learn How To See',
        definition: 'd',
        evidence: ['H-001'],
        codebookId: 'voices',
        author: RESEARCHER,
      }),
    )
  })

  it('rejects an in_vivo code whose name is NOT in its evidence', () => {
    assert.throws(
      () =>
        createCode(path, {
          name: 'situated knowledge', // not in H-001's text
          definition: 'd',
          evidence: ['H-001'],
          codebookId: 'voices',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /verbatim/.test(e.message),
    )
  })

  it('rejects an in_vivo code with no evidence to validate against', () => {
    assert.throws(
      () =>
        createCode(path, {
          name: 'answerable',
          definition: 'd',
          codebookId: 'voices',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /needs evidence/.test(e.message),
    )
  })

  it('keeps enforcing even if the in_vivo codebook was rejected (no silent disable)', () => {
    // Reject the codebook; resolveCodebookId still resolves its id, so a code
    // can be created under it — enforcement must NOT degrade to inductive.
    rejectArtifact(path, 'CB-voices', 'reviewer@example.com')
    assert.throws(
      () =>
        createCode(path, {
          name: 'totally unrelated phrase',
          definition: 'd',
          evidence: ['H-001'],
          codebookId: 'voices',
          author: RESEARCHER,
        }),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /verbatim/.test(e.message),
    )
  })

  it('does NOT enforce verbatim for non-in_vivo codebooks (primary / framework)', () => {
    // primary (inductive) — any name is fine, no evidence required.
    assert.doesNotThrow(() =>
      createCode(path, { name: 'free-form descriptive code', definition: 'd', author: RESEARCHER }),
    )
    createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
    assert.doesNotThrow(() =>
      createCode(path, {
        name: 'situated-standpoint',
        definition: 'd',
        codebookId: 'epistemology',
        author: RESEARCHER,
      }),
    )
  })
})

describe('create is atomic — no orphaned markdown (#165)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  // An AI author missing prompt_hash fails the events schema. The file is
  // written before the event is emitted, so without rollback it would orphan.
  const AI_NO_HASH: Author = {
    actorType: 'ai',
    actorId: 'claude-code:0.1.0:abc12345',
    model: 'anthropic:claude',
    // promptHash deliberately omitted → SCHEMA_VIOLATION on emit
  }

  it('rolls the markdown back when the create event fails validation', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(() => createCode(path, { name: 'orphan', definition: 'x', author: AI_NO_HASH }))
    // The orphan-to-be must NOT remain on disk.
    assert.equal(existsSync(join(path, 'codebook', 'orphan.md')), false)
  })

  it('does not block re-creation after a failed create', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(() => createCode(path, { name: 'retry', definition: 'x', author: AI_NO_HASH }))
    // Re-running with a valid author now succeeds (the failed attempt left nothing behind).
    const ok = createCode(path, {
      name: 'retry',
      definition: 'x',
      author: {
        actorType: 'ai',
        actorId: 'claude-code:0.1.0:abc12345',
        model: 'm',
        promptHash: 'a'.repeat(64),
      },
    })
    assert.equal(ok.id, 'C-primary/retry')
    assert.ok(existsSync(ok.path))
  })

  it('also rolls back highlights (fresh sequential id is freed)', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(() =>
      createHighlight(path, {
        sessionId: 'S001',
        utteranceId: 'U-1',
        span: [0, 1],
        text: 'x',
        author: AI_NO_HASH,
      }),
    )
    assert.equal(existsSync(join(path, 'highlights', 'H-001.md')), false)
  })
})

describe('endorseArtifact', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-artifacts-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('chains an endorse event onto an AI draft (full blame lineage)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, { name: 'distrust', definition: 'x', author: AI })

    const res = endorseArtifact(path, created.artifact_id, 'juan@example.com')
    assert.equal(res.artifact_id, created.artifact_id)
    assert.equal(res.parent_event_id, created.event_id)

    // blame now shows create(ai) → endorse(researcher)
    const lineage = blame(created.artifact_id, { cwd: work, seed: 'demo' })
    assert.equal(lineage.events.length, 2)
    assert.equal(lineage.events[0]?.action, 'create')
    assert.equal(lineage.events[0]?.actor_type, 'ai')
    assert.equal(lineage.events[1]?.action, 'endorse')
    assert.equal(lineage.events[1]?.actor_type, 'researcher')
    assert.equal(lineage.events[1]?.parent_event, created.event_id)
  })

  it('resolves latest:<kind>=<seed> refs like blame does', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'one', definition: 'x', author: AI })
    const res = endorseArtifact(path, 'latest:code=demo', 'juan@example.com')
    assert.ok(res.endorse_event_id.length > 0)
  })

  it('errors on an unknown ref', () => {
    const { path } = initSeed('demo', { cwd: work })
    createCode(path, { name: 'one', definition: 'x', author: AI })
    assert.throws(
      () => endorseArtifact(path, 'deadbeef', 'juan@example.com'),
      (e: unknown) => e instanceof CompostError && e.code === 'FILE_NOT_FOUND',
    )
  })

  it('refuses a self-endorse — the creator can not endorse their own artifact (#236)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const created = createCode(path, { name: 'self', definition: 'x', author: AI })
    // Endorsing under the SAME actor_id the AI created with collapses the gate.
    assert.throws(
      () => endorseArtifact(path, created.artifact_id, AI.actorId),
      (e: unknown) =>
        e instanceof CompostError && e.code === 'INVALID_INPUT' && /self-endorse/.test(e.message),
    )
    // A distinct researcher still endorses fine.
    assert.ok(endorseArtifact(path, created.artifact_id, 'juan@example.com').endorse_event_id)
  })

  // The id `compost create` prints (C-slug / H-NNN / T-slug) must round-trip
  // into endorse — the obvious next command. Before #168, only SHA prefixes
  // and `latest:` refs worked, so users had to copy the artifact_id instead.
  describe('accepts the human id from create (#168)', () => {
    it('endorses a code by its C-slug', () => {
      const { path } = initSeed('demo', { cwd: work })
      const code = createCode(path, { name: 'access-model-clarity', definition: 'x', author: AI })
      assert.equal(code.id, 'C-primary/access-model-clarity')

      const res = endorseArtifact(path, code.id, 'juan@example.com')
      assert.equal(res.artifact_id, code.artifact_id)
      assert.equal(res.parent_event_id, code.event_id)
    })

    it('endorses a qualified code by its BARE shorthand (#269 shim)', () => {
      const { path } = initSeed('demo', { cwd: work })
      // Stored id is qualified C-primary/clarity; user refers to it bare.
      const code = createCode(path, { name: 'clarity', definition: 'x', author: AI })
      assert.equal(code.id, 'C-primary/clarity')

      const res = endorseArtifact(path, 'C-clarity', 'juan@example.com') // bare
      assert.equal(res.artifact_id, code.artifact_id)
      // blame round-trips on the bare ref too.
      assert.equal(blame('C-clarity', { cwd: work, seed: 'demo' }).events.length, 2)
    })

    it('refuses a BARE ref ambiguous across two frames (#269 shim)', () => {
      const { path } = initSeed('demo', { cwd: work })
      createCodebook(path, { name: 'epistemology', stance: 'framework', author: RESEARCHER })
      // `clarity` now exists in two frames — only qualified paths make this possible.
      createCode(path, { name: 'clarity', definition: 'x', author: AI }) // C-primary/clarity
      createCode(path, {
        name: 'clarity',
        definition: 'x',
        codebookId: 'CB-epistemology',
        author: AI,
      }) // C-epistemology/clarity
      // Bare `C-clarity` is ambiguous → the LIKE branch returns 2 rows → no match.
      assert.throws(() => endorseArtifact(path, 'C-clarity', 'juan@example.com'))
    })

    it('endorses a highlight by its H-NNN id', () => {
      const { path } = initSeed('demo', { cwd: work })
      const hl = createHighlight(path, {
        sessionId: 'S001',
        utteranceId: 'U-1',
        span: [0, 4],
        text: 'foo',
        author: AI,
      })
      assert.equal(hl.id, 'H-001')

      const res = endorseArtifact(path, hl.id, 'juan@example.com')
      assert.equal(res.artifact_id, hl.artifact_id)
    })

    it('endorses a theme by its T-slug', () => {
      const { path } = initSeed('demo', { cwd: work })
      const theme = createTheme(path, {
        name: 'control-earns-trust',
        summary: 'x',
        author: AI,
      })
      assert.equal(theme.id, 'T-control-earns-trust')

      const res = endorseArtifact(path, theme.id, 'juan@example.com')
      assert.equal(res.artifact_id, theme.artifact_id)
    })

    it('errors with a clear message when the human id has no match', () => {
      const { path } = initSeed('demo', { cwd: work })
      createCode(path, { name: 'one', definition: 'x', author: AI })
      assert.throws(
        () => endorseArtifact(path, 'C-nope', 'juan@example.com'),
        (e: unknown) =>
          e instanceof CompostError &&
          e.code === 'FILE_NOT_FOUND' &&
          /C-nope/.test((e as CompostError).message),
      )
    })

    it('rejects a wholly-malformed ref with a message that names the accepted forms', () => {
      const { path } = initSeed('demo', { cwd: work })
      createCode(path, { name: 'one', definition: 'x', author: AI })
      assert.throws(
        () => endorseArtifact(path, 'not-a-ref!', 'juan@example.com'),
        (e: unknown) =>
          e instanceof CompostError &&
          e.code === 'INVALID_INPUT' &&
          /C-slug/.test((e as CompostError).message) &&
          /SHA256/.test((e as CompostError).message),
      )
    })
  })

  // A second endorse by the same researcher must NOT double-record (#169).
  // The earlier bug: SHA-then-latest endorsed the same artifact twice with
  // ok/ok, writing two endorse events that share parent_event.
  describe('idempotent on re-endorse by the same researcher (#169)', () => {
    it('returns the existing endorse instead of emitting a duplicate', () => {
      const { path } = initSeed('demo', { cwd: work })
      const code = createCode(path, { name: 'distrust', definition: 'x', author: AI })

      const first = endorseArtifact(path, code.artifact_id, 'juan@example.com')
      assert.equal(first.already_endorsed, undefined)

      const second = endorseArtifact(path, code.artifact_id, 'juan@example.com')
      assert.equal(second.already_endorsed, true)
      assert.equal(second.endorse_event_id, first.endorse_event_id)
      assert.equal(second.parent_event_id, first.parent_event_id)
    })

    it('keeps the timeline at exactly one endorse (no duplicate event row)', () => {
      const { path } = initSeed('demo', { cwd: work })
      const code = createCode(path, { name: 'distrust2', definition: 'x', author: AI })
      endorseArtifact(path, code.artifact_id, 'juan@example.com')
      endorseArtifact(path, code.artifact_id, 'juan@example.com')

      const lineage = blame(code.artifact_id, { cwd: work, seed: 'demo' })
      const endorses = lineage.events.filter((e) => e.action === 'endorse')
      assert.equal(endorses.length, 1, `expected 1 endorse, got ${endorses.length}`)
    })

    it('treats SHA-then-latest as the same artifact (idempotent across ref forms)', () => {
      const { path } = initSeed('demo', { cwd: work })
      const code = createCode(path, { name: 'distrust3', definition: 'x', author: AI })

      endorseArtifact(path, code.artifact_id, 'juan@example.com')
      const second = endorseArtifact(path, 'latest:code=demo', 'juan@example.com')
      assert.equal(second.already_endorsed, true)

      const lineage = blame(code.artifact_id, { cwd: work, seed: 'demo' })
      assert.equal(lineage.events.filter((e) => e.action === 'endorse').length, 1)
    })

    it('lets a different researcher add a second endorse (per-researcher, not per-artifact)', () => {
      const { path } = initSeed('demo', { cwd: work })
      const code = createCode(path, { name: 'distrust4', definition: 'x', author: AI })

      endorseArtifact(path, code.artifact_id, 'juan@example.com')
      const otherRes = endorseArtifact(path, code.artifact_id, 'sam@example.com')
      assert.equal(otherRes.already_endorsed, undefined)

      const lineage = blame(code.artifact_id, { cwd: work, seed: 'demo' })
      const endorses = lineage.events.filter((e) => e.action === 'endorse')
      assert.equal(endorses.length, 2)
      assert.deepEqual(endorses.map((e) => e.actor_id).sort(), [
        'juan@example.com',
        'sam@example.com',
      ])
    })
  })
})

describe('slug — diacritic folding', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-slug-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('folds accents/ñ to ASCII instead of dropping them (no internal hyphens)', () => {
    const { path } = initSeed('demo', { cwd: work })
    const a = createCode(path, { name: 'niñez', definition: 'childhood', author: RESEARCHER })
    assert.equal(a.id, 'C-primary/ninez') // not the old lossy "ni-ez"
    assert.ok(a.path.endsWith('codebook/primary/ninez.md'))

    const b = createCode(path, { name: 'café después', definition: 'x', author: RESEARCHER })
    assert.equal(b.id, 'C-primary/cafe-despues')
  })

  it('still rejects a name with no transliterable characters', () => {
    const { path } = initSeed('demo', { cwd: work })
    assert.throws(
      () => createCode(path, { name: '🙂', definition: 'x', author: RESEARCHER }),
      (e: unknown) => e instanceof CompostError && e.code === 'INVALID_INPUT',
    )
  })
})
