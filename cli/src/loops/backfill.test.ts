import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { chunkIdFor, chunkTranscript } from '@they-juanreina/compost-retrieval'

import { initSeed } from '../lib/seed.js'
import { computeCodeBackfill } from './backfill.js'

function fm(path: string, fields: Record<string, string>): void {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(path, `---\n${body}\n---\n\nbody\n`, 'utf8')
}

describe('computeCodeBackfill (#275)', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-backfill-'))
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function seedCorpus(path: string): void {
    mkdirSync(join(path, 'sessions/S001'), { recursive: true })
    writeFileSync(
      join(path, 'sessions/S001/transcript.json'),
      JSON.stringify({
        session_id: 'S001',
        utterances: [
          { id: 'U-0001', text: 'I distrust the alert' },
          { id: 'U-0002', text: 'the override helps' },
        ],
      }),
    )
    fm(join(path, 'highlights/H-001.md'), {
      id: 'H-001',
      session_id: 'S001',
      utterance_id: 'U-0001',
    })
    fm(join(path, 'highlights/H-002.md'), {
      id: 'H-002',
      session_id: 'S001',
      utterance_id: 'U-0002',
    })
  }

  it('maps code evidence → utterance → utterance+highlight chunk patches', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedCorpus(path)
    fm(join(path, 'codebook/distrust.md'), {
      id: 'C-distrust',
      codebook_id: 'CB-primary',
      evidence: '[H-001]',
    })

    const patches = computeCodeBackfill(path)
    // Two chunk types (utterance + highlight) for the one coded utterance.
    const byId = new Map(patches.map((p) => [p.id, p]))
    const uId = chunkIdFor('I distrust the alert', 'utterance')
    const hId = chunkIdFor('I distrust the alert', 'highlight')
    assert.deepEqual(byId.get(uId)?.code_ids, ['C-distrust'])
    assert.deepEqual(byId.get(uId)?.codebook_ids, ['CB-primary'])
    assert.deepEqual(byId.get(hId)?.code_ids, ['C-distrust'])
    // U-0002 is uncoded → no patch references its text.
    assert.ok(!byId.has(chunkIdFor('the override helps', 'utterance')))
  })

  it('unions codes and codebook frames covering the same utterance', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedCorpus(path)
    // Two codes from two different codebooks both evidence H-001 (utterance U-0001).
    fm(join(path, 'codebook/distrust.md'), {
      id: 'C-distrust',
      codebook_id: 'CB-primary',
      evidence: '[H-001]',
    })
    fm(join(path, 'codebook/power.md'), {
      id: 'C-power',
      codebook_id: 'CB-critical',
      evidence: '[H-001]',
    })

    const patches = computeCodeBackfill(path)
    const uId = chunkIdFor('I distrust the alert', 'utterance')
    const patch = patches.find((p) => p.id === uId)
    assert.deepEqual(patch?.code_ids, ['C-distrust', 'C-power'])
    assert.deepEqual(patch?.codebook_ids, ['CB-critical', 'CB-primary']) // sorted set
  })

  it('defaults a code with no codebook_id to CB-primary', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedCorpus(path)
    fm(join(path, 'codebook/legacy.md'), { id: 'C-legacy', evidence: '[H-002]' })
    const patch = computeCodeBackfill(path).find(
      (p) => p.id === chunkIdFor('the override helps', 'utterance'),
    )
    assert.deepEqual(patch?.codebook_ids, ['CB-primary'])
  })

  it('is empty when nothing is coded', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedCorpus(path)
    assert.deepEqual(computeCodeBackfill(path), [])
  })

  it('targets the exact chunk id the chunker emits (guards chunkIdFor drift)', () => {
    const { path } = initSeed('demo', { cwd: work })
    seedCorpus(path)
    fm(join(path, 'codebook/distrust.md'), {
      id: 'C-distrust',
      codebook_id: 'CB-primary',
      evidence: '[H-001]',
    })
    // The id the real chunker produces for U-0001's utterance chunk...
    const emitted = chunkTranscript(
      {
        session_id: 'S001',
        utterances: [
          { id: 'U-0001', speaker_id: 'S1', start_ms: 0, end_ms: 0, text: 'I distrust the alert' },
        ],
      },
      { seed: 'demo' },
    ).find((c) => c.metadata.chunk_type === 'utterance')
    assert.ok(emitted)
    // ...must be exactly what the backfill patches.
    assert.ok(computeCodeBackfill(path).some((p) => p.id === emitted.id))
  })
})
