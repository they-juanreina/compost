import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CompostError } from '../errors.js'
import type { LegacyIngestRequest } from '../legacy_client.js'
import { legacyIngestNative } from './legacyNative.js'
import type { SpawnImpl } from './nativeRuntime.js'

const REQ: LegacyIngestRequest = { seed_path: '/seed', source_path: '/seed/legacy/x.csv' }

function spawnReturning(line: string, status = 0): SpawnImpl {
  return () => ({ status, stdout: `${line}\n`, stderr: '', error: undefined })
}

describe('legacyIngestNative (#184)', () => {
  it('parses the native CLI JSON result on success', () => {
    let seenArgs: string[] = []
    const spawn: SpawnImpl = (_cmd, args) => {
      seenArgs = args
      return {
        status: 0,
        stdout: `${JSON.stringify({ status: 'ok', source_path: REQ.source_path, normalized_path: '/seed/legacy/x.json', utterance_count: 3, text_col_resolved: 'text', warnings: [] })}\n`,
        stderr: '',
        error: undefined,
      }
    }
    const resp = legacyIngestNative(REQ, { python: 'py', transcriberDir: '/t', spawnImpl: spawn })
    assert.equal(resp.status, 'ok')
    assert.equal(resp.utterance_count, 3)
    assert.equal(resp.normalized_path, '/seed/legacy/x.json')
    assert.ok(seenArgs.includes('app.legacy_cli'))
    assert.ok(seenArgs.includes('--source-path'))
  })

  it('forwards CSV column kwargs as flags', () => {
    let seenArgs: string[] = []
    const spawn: SpawnImpl = (_cmd, args) => {
      seenArgs = args
      return spawnReturning(JSON.stringify({ status: 'ok', utterance_count: 1 }))(
        _cmd,
        args,
        {} as never,
      )
    }
    legacyIngestNative(
      { ...REQ, text_col: 'Response', speaker_col: 'Who' },
      { python: 'py', transcriberDir: '/t', spawnImpl: spawn },
    )
    const ti = seenArgs.indexOf('--text-col')
    assert.equal(seenArgs[ti + 1], 'Response')
    const si = seenArgs.indexOf('--speaker-col')
    assert.equal(seenArgs[si + 1], 'Who')
  })

  it('throws CompostError on a status:failed payload', () => {
    const spawn = spawnReturning(
      JSON.stringify({ status: 'failed', kind: 'dep_missing', error: 'python-docx' }),
      1,
    )
    assert.throws(
      () => legacyIngestNative(REQ, { python: 'py', transcriberDir: '/t', spawnImpl: spawn }),
      CompostError,
    )
  })

  it('throws CompostError when the process fails to start', () => {
    const spawn: SpawnImpl = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT'),
    })
    assert.throws(
      () => legacyIngestNative(REQ, { python: 'py', transcriberDir: '/t', spawnImpl: spawn }),
      /failed to start/,
    )
  })
})
