import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { gatherSessionsWithThemes } from './saturate.js'
import { initSeed } from './seed.js'

function writeFrontmatter(path: string, fm: Record<string, string>): void {
  const body = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(path, `---\n${body}\n---\n\nbody\n`, 'utf8')
}

describe('gatherSessionsWithThemes', () => {
  let work: string

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-saturate-'))
  })

  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('joins theme → code → highlight → session', () => {
    const { path } = initSeed('demo', { cwd: work })

    mkdirSync(join(path, 'sessions/S001'))
    mkdirSync(join(path, 'sessions/S002'))

    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S001' })
    writeFrontmatter(join(path, 'highlights/H-002.md'), { id: 'H-002', session_id: 'S002' })

    writeFrontmatter(join(path, 'codebook/distrust.md'), {
      id: 'C-distrust',
      evidence: '[H-001, H-002]',
    })
    writeFrontmatter(join(path, 'codebook/control.md'), {
      id: 'C-control',
      evidence: '[H-002]',
    })

    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    writeFrontmatter(join(path, 'synthesis/themes/trust.md'), {
      id: 'T-trust',
      codes: '[C-distrust]',
    })
    writeFrontmatter(join(path, 'synthesis/themes/agency.md'), {
      id: 'T-agency',
      codes: '[C-control]',
    })

    assert.deepEqual(gatherSessionsWithThemes({ cwd: work, seed: 'demo' }), [
      { id: 'S001', themes: ['T-trust'] },
      { id: 'S002', themes: ['T-agency', 'T-trust'] },
    ])
  })

  it('reads the new evidence[] theme format (#266)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    mkdirSync(join(path, 'sessions/S002'))

    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S001' })
    writeFrontmatter(join(path, 'highlights/H-002.md'), { id: 'H-002', session_id: 'S002' })
    writeFrontmatter(join(path, 'codebook/distrust.md'), { id: 'C-distrust', evidence: '[H-001]' })
    writeFrontmatter(join(path, 'codebook/control.md'), { id: 'C-control', evidence: '[H-002]' })

    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    // Heterogeneous evidence tokens (kind:ref:codebook_id), as createTheme writes.
    writeFrontmatter(join(path, 'synthesis/themes/trust.md'), {
      id: 'T-trust',
      evidence: '[code:C-distrust:CB-primary, code:C-control:CB-primary]',
      codebook_id: 'CB-primary',
    })

    assert.deepEqual(gatherSessionsWithThemes({ cwd: work, seed: 'demo' }), [
      { id: 'S001', themes: ['T-trust'] },
      { id: 'S002', themes: ['T-trust'] },
    ])
  })

  it('finds namespaced codes created via createCode (#269 dual-layout)', async () => {
    const { createCode, createTheme } = await import('./artifacts.js')
    const RESEARCHER = { actorType: 'researcher' as const, actorId: 'juan@example.com' }
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S001' })
    // Real createCode → codebook/primary/distrust.md (nested), id
    // C-primary/distrust. A flat-only reader would miss it entirely.
    createCode(path, { name: 'distrust', definition: 'd', evidence: ['H-001'], author: RESEARCHER })
    createTheme(path, {
      name: 'trust',
      summary: 's',
      evidence: [{ kind: 'code', ref: 'C-distrust' }],
      author: RESEARCHER,
    })
    assert.deepEqual(gatherSessionsWithThemes({ cwd: work, seed: 'demo' }), [
      { id: 'S001', themes: ['T-trust'] },
    ])
  })

  it('scopes to one codebook — out-of-frame codes contribute no coverage (#264)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    mkdirSync(join(path, 'sessions/S002'))

    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S001' })
    writeFrontmatter(join(path, 'highlights/H-002.md'), { id: 'H-002', session_id: 'S002' })

    // C-epi in the epistemology frame (S001); C-just in pluriversal-justice (S002).
    writeFrontmatter(join(path, 'codebook/epi.md'), {
      id: 'C-epi',
      codebook_id: 'CB-epistemology',
      evidence: '[H-001]',
    })
    writeFrontmatter(join(path, 'codebook/just.md'), {
      id: 'C-just',
      codebook_id: 'CB-pluriversal-justice',
      evidence: '[H-002]',
    })
    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    writeFrontmatter(join(path, 'synthesis/themes/t.md'), {
      id: 'T-x',
      codes: '[C-epi, C-just]',
    })

    // Scoped to epistemology: only S001 (via C-epi) carries the theme.
    assert.deepEqual(
      gatherSessionsWithThemes({ cwd: work, seed: 'demo', codebookId: 'CB-epistemology' }),
      [
        { id: 'S001', themes: ['T-x'] },
        { id: 'S002', themes: [] },
      ],
    )
    // Unscoped: both frames' codes count.
    assert.deepEqual(gatherSessionsWithThemes({ cwd: work, seed: 'demo' }), [
      { id: 'S001', themes: ['T-x'] },
      { id: 'S002', themes: ['T-x'] },
    ])
  })

  it('treats a code without codebook_id as CB-primary when scoping (#264)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S001' })
    // Pre-codebook code: no codebook_id frontmatter → defaults to CB-primary.
    writeFrontmatter(join(path, 'codebook/legacy.md'), { id: 'C-legacy', evidence: '[H-001]' })
    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    writeFrontmatter(join(path, 'synthesis/themes/t.md'), { id: 'T-x', codes: '[C-legacy]' })

    assert.deepEqual(
      gatherSessionsWithThemes({ cwd: work, seed: 'demo', codebookId: 'CB-primary' }),
      [{ id: 'S001', themes: ['T-x'] }],
    )
  })

  it('returns sessions with empty themes when no synthesis exists yet', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    mkdirSync(join(path, 'sessions/S002'))

    assert.deepEqual(gatherSessionsWithThemes({ cwd: work, seed: 'demo' }), [
      { id: 'S001', themes: [] },
      { id: 'S002', themes: [] },
    ])
  })

  it('ignores _inbox and dotfiles when listing sessions', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    writeFileSync(join(path, 'sessions/_inbox/raw.mp4'), '')

    const result = gatherSessionsWithThemes({ cwd: work, seed: 'demo' })
    assert.deepEqual(
      result.map((r) => r.id),
      ['S001'],
    )
  })

  // saturate must use the same canonical-session predicate as `compost status`
  // (#166). Pre-fix: legacy carry-over folders like `Attachments/`, `Transcripts/`
  // were counted as sessions, so `saturate.sessions: 5` while `status` showed 1.
  it('skips non-canonical session folders (Attachments, Transcripts, Output, …) (#166)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    // Legacy carry-over folders that survived a partial seed migration.
    mkdirSync(join(path, 'sessions/Attachments'))
    mkdirSync(join(path, 'sessions/Output'))
    mkdirSync(join(path, 'sessions/Survey'))
    mkdirSync(join(path, 'sessions/Transcripts'))

    const result = gatherSessionsWithThemes({ cwd: work, seed: 'demo' })
    assert.deepEqual(
      result.map((r) => r.id),
      ['S001'],
    )
  })

  it('counts a non-S\\d+ folder when it has a transcript.json (canonical via content) (#166)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/Pilot-1'))
    writeFileSync(join(path, 'sessions/Pilot-1/transcript.json'), '{}')

    const result = gatherSessionsWithThemes({ cwd: work, seed: 'demo' })
    assert.deepEqual(
      result.map((r) => r.id),
      ['Pilot-1'],
    )
  })

  it('counts a non-S\\d+ folder when it has a source.<ext> file (queued) (#166)', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/queued-interview'))
    writeFileSync(join(path, 'sessions/queued-interview/source.mp4'), '')

    const result = gatherSessionsWithThemes({ cwd: work, seed: 'demo' })
    assert.deepEqual(
      result.map((r) => r.id),
      ['queued-interview'],
    )
  })

  it('throws SCHEMA_VIOLATION when a highlight points at a missing session dir', () => {
    const { path } = initSeed('demo', { cwd: work })
    mkdirSync(join(path, 'sessions/S001'))
    writeFrontmatter(join(path, 'highlights/H-001.md'), { id: 'H-001', session_id: 'S999' })
    writeFrontmatter(join(path, 'codebook/x.md'), { id: 'C-x', evidence: '[H-001]' })
    mkdirSync(join(path, 'synthesis/themes'), { recursive: true })
    writeFrontmatter(join(path, 'synthesis/themes/t.md'), { id: 'T-x', codes: '[C-x]' })

    assert.throws(
      () => gatherSessionsWithThemes({ cwd: work, seed: 'demo' }),
      (err: unknown) => err instanceof CompostError && err.code === 'SCHEMA_VIOLATION',
    )
  })
})
