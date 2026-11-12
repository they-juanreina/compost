import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import { blame, renderHuman } from './blame.js'
import { SUPPORTED_EXTENSIONS } from './dispatch.js'
import {
  findDuplicateIngests,
  INGEST_ARTIFACT_KIND,
  INGEST_FORMATS,
  ingestFormatOf,
  listTranscriptIngests,
  type RecordIngestInput,
  recordTranscriptIngest,
  sha256Bytes,
  sha256File,
} from './ingestProvenance.js'
import { initSeed } from './seed.js'

const SHA_A = sha256Bytes(Buffer.from('file A'))
const SHA_B = sha256Bytes(Buffer.from('file B'))

function input(over: Partial<RecordIngestInput> = {}): RecordIngestInput {
  return {
    sessionId: 'S001',
    originalName: 'teams.vtt',
    format: 'vtt',
    parser: 'compost-import',
    parserVersion: '0.1.0',
    sha256: SHA_A,
    author: { type: 'researcher', id: 'juan' },
    now: () => new Date('2026-11-01T10:00:00.000Z'),
    ...over,
  }
}

describe('recordTranscriptIngest (ADR 0006, #325)', () => {
  let work: string
  let seed: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-ingestprov-'))
    seed = initSeed('demo', { cwd: work }).path
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('emits one researcher event carrying the full ADR payload', () => {
    const r = recordTranscriptIngest(seed, input({ sourceUri: 'file:///tmp/teams.vtt' }))
    assert.ok(r.event_id)
    assert.deepEqual(r.duplicate_of, [])
    assert.deepEqual(listTranscriptIngests(seed), [
      {
        session_id: 'S001',
        original_name: 'teams.vtt',
        source_uri: 'file:///tmp/teams.vtt',
        format: 'vtt',
        parser: 'compost-import',
        parser_version: '0.1.0',
        ingested_at: '2026-11-01T10:00:00.000Z',
        actor: 'researcher',
        sha256: SHA_A,
      },
    ])
  })

  it('records an agent actor with agent name/version (queue worker)', () => {
    recordTranscriptIngest(
      seed,
      input({
        parser: 'transcribe-worker',
        format: 'mp4',
        author: { type: 'agent', name: 'transcribe-worker', version: '0.1.0' },
      }),
    )
    const [p] = listTranscriptIngests(seed)
    assert.equal(p?.actor, 'agent')
    assert.equal(p?.source_uri, undefined) // optional, omitted rather than null
  })

  it('does not double-emit when a second path lands the same bytes in the same session', () => {
    const first = recordTranscriptIngest(seed, input())
    const second = recordTranscriptIngest(
      seed,
      input({
        parser: 'legacy-ingest-worker',
        author: { type: 'agent', name: 'legacy-ingest-worker', version: '0.1.0' },
      }),
    )
    assert.ok(first.event_id)
    assert.equal(second.event_id, null)
    assert.equal(listTranscriptIngests(seed).length, 1)
  })

  it('rejects a malformed sha256 with an actionable error', () => {
    assert.throws(
      () => recordTranscriptIngest(seed, input({ sha256: 'nope' })),
      (e) =>
        e instanceof CompostError &&
        e.code === 'INVALID_INPUT' &&
        /original source file/.test(e.message),
    )
  })

  it('flags the same bytes landing in a second session, without blocking', () => {
    recordTranscriptIngest(seed, input())
    const again = recordTranscriptIngest(
      seed,
      input({ sessionId: 'S002', originalName: 'copy.vtt' }),
    )
    assert.ok(again.event_id, 'a duplicate is recorded, not blocked')
    assert.deepEqual(again.duplicate_of, ['S001'])
    recordTranscriptIngest(seed, input({ sessionId: 'S003', sha256: SHA_B }))
    assert.deepEqual(findDuplicateIngests(seed), [
      {
        sha256: SHA_A,
        count: 2,
        sessions: ['S001', 'S002'],
        original_names: ['teams.vtt', 'copy.vtt'],
      },
    ])
  })

  it('makes `blame <session-id>` show the ingest event, with no endorse step', () => {
    recordTranscriptIngest(seed, input())
    const result = blame('S001', { cwd: work })
    assert.equal(result.events.length, 1)
    const e = result.events[0]
    assert.equal(e?.artifact_kind, INGEST_ARTIFACT_KIND)
    assert.equal(e?.action, 'create')
    assert.equal(e?.actor_type, 'researcher')
    assert.match(
      renderHuman(result),
      /ingested teams\.vtt \(vtt\) into S001 via compost-import@0\.1\.0/,
    )
  })

  it('blame on an agent-landed session names the agent', () => {
    recordTranscriptIngest(
      seed,
      input({ author: { type: 'agent', name: 'transcribe-worker', version: '0.1.0' } }),
    )
    const e = blame('S001', { cwd: work }).events[0]
    assert.equal(e?.actor_type, 'agent')
    assert.equal(e?.agent_name, 'transcribe-worker')
  })
})

describe('ingest format + hashing helpers', () => {
  it('knows every extension the queue can classify, plus caption formats', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      assert.ok((INGEST_FORMATS as readonly string[]).includes(ext.slice(1)), ext)
    }
    assert.ok(INGEST_FORMATS.includes('vtt') && INGEST_FORMATS.includes('srt'))
  })

  it('maps names to formats; unknown extensions were parsed as text', () => {
    assert.equal(ingestFormatOf('/x/Call.SRT'), 'srt')
    assert.equal(ingestFormatOf('notes.txt'), 'txt')
    assert.equal(ingestFormatOf('transcript'), 'txt')
  })

  it('sha256File matches sha256Bytes of the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compost-sha-'))
    try {
      const p = join(dir, 'a.txt')
      writeFileSync(p, 'file A')
      assert.equal(sha256File(p), SHA_A)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
