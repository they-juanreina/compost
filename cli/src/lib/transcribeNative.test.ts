import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isCompostError } from '../errors.js'
import type { SpawnImpl } from './nativeRuntime.js'
import { transcribeNative } from './transcribeNative.js'

function fakeSpawn(ret: {
  status?: number | null
  stdout?: string
  stderr?: string
  error?: Error
}): SpawnImpl {
  return () => ({
    status: ret.status ?? 0,
    stdout: ret.stdout ?? '',
    stderr: ret.stderr ?? '',
    error: ret.error,
  })
}

const base = { python: 'python', transcriberDir: '/t', engine: 'parakeet' }

/** Run fn, return the thrown error (or fail if it didn't throw). */
function catchErr(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw, but it did not')
}

describe('transcribeNative', () => {
  it('parses the entrypoint JSON result on success', () => {
    const out = JSON.stringify({
      session_id: 'S001',
      transcript_path: '/t/sessions/S001/transcript.json',
      status: 'ok',
      engine: 'parakeet',
      model: 'mlx-community/parakeet-tdt-0.6b-v3',
    })
    const r = transcribeNative('/seed', 'S001', '/seed/sessions/S001/source.mp3', {
      ...base,
      spawnImpl: fakeSpawn({ stdout: `noise line\n${out}\n` }),
    })
    assert.equal(r.session_id, 'S001')
    assert.equal(r.status, 'ok')
    assert.equal(r.engine, 'parakeet')
  })

  it('throws a CompostError when the entrypoint reports status: failed', () => {
    const err = catchErr(() =>
      transcribeNative('/seed', 'S001', '/s.mp3', {
        ...base,
        spawnImpl: fakeSpawn({
          status: 1,
          stdout: JSON.stringify({ status: 'failed', error: 'metal OOM' }),
        }),
      }),
    )
    assert.ok(isCompostError(err))
    assert.match((err as Error).message, /metal OOM/)
  })

  it('throws when the process exits non-zero even with ok-looking payload', () => {
    const err = catchErr(() =>
      transcribeNative('/seed', 'S001', '/s.mp3', {
        ...base,
        spawnImpl: fakeSpawn({ status: 2, stdout: '', stderr: 'traceback...' }),
      }),
    )
    assert.ok(isCompostError(err))
  })

  it('throws a clear error when output is not parseable', () => {
    const err = catchErr(() =>
      transcribeNative('/seed', 'S001', '/s.mp3', {
        ...base,
        spawnImpl: fakeSpawn({ stdout: 'not json', stderr: 'boom' }),
      }),
    ) as Error
    assert.ok(isCompostError(err))
    assert.match(err.message, /no parseable result/)
  })

  it('throws a CompostError (not a raw TypeError) on a non-object JSON primitive', () => {
    for (const stdout of ['null', '123', '"str"', 'true']) {
      const err = catchErr(() =>
        transcribeNative('/seed', 'S001', '/s.mp3', { ...base, spawnImpl: fakeSpawn({ stdout }) }),
      ) as Error
      assert.ok(isCompostError(err), `${stdout} should yield a CompostError`)
      assert.match(err.message, /no parseable result/)
    }
  })

  it('throws when spawn itself fails', () => {
    const err = catchErr(() =>
      transcribeNative('/seed', 'S001', '/s.mp3', {
        ...base,
        spawnImpl: fakeSpawn({ error: new Error('ENOENT') }),
      }),
    ) as Error
    assert.ok(isCompostError(err))
    assert.match(err.message, /failed to start/)
  })
})
