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
