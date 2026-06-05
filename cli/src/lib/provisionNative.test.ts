import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { isCompostError } from '../errors.js'
import { findRepoTranscriberDir } from './nativeRuntime.js'
import { NATIVE_DEPS, type ProvisionExec, provisionNativeVenv } from './provisionNative.js'

const ENV = { COMPOST_HOME: '/home' }
const VENV_PY = '/home/transcriber-venv/bin/python'

/** Programmable exec fake routing by argv shape. */
function makeExec(o: {
  pyVersion?: string
  verifyOk?: boolean
  pipOk?: boolean
  venvOk?: boolean
  calls?: string[][]
}): ProvisionExec {
  return (cmd, args) => {
    o.calls?.push([cmd, ...args])
    if (args.includes('--version'))
      return { ok: o.pyVersion !== undefined, stdout: o.pyVersion ?? '', stderr: '' }
    if (args[0] === '-c')
      return {
        ok: o.verifyOk ?? true,
        stdout: '',
        stderr: o.verifyOk === false ? 'ImportError' : '',
      }
    if (args[0] === '-m' && args[1] === 'venv')
      return { ok: o.venvOk ?? true, stdout: '', stderr: o.venvOk === false ? 'venv boom' : '' }
    if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'install')
      return { ok: o.pipOk ?? true, stdout: '', stderr: o.pipOk === false ? 'pip boom' : '' }
    return { ok: true, stdout: '', stderr: '' }
  }
}

const base = { env: ENV, transcriberDir: '/t' }
const transcriberOk = (p: string) => p === '/t/pyproject.toml'

function catchErr(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected throw')
}

describe('provisionNativeVenv', () => {
  it('no-ops when the venv already imports the deps', () => {
    const calls: string[][] = []
    const r = provisionNativeVenv({
      ...base,
      exists: (p) => transcriberOk(p) || p === VENV_PY,
      exec: makeExec({ verifyOk: true, calls }),
    })
    assert.equal(r.status, 'already-ready')
    assert.equal(r.venvPython, VENV_PY)
    // only the verify probe ran — no venv create / pip install
    assert.ok(!calls.some((c) => c.includes('venv') || c.includes('pip')))
  })

  it('provisions fresh: resolve python → create venv → pip install → verify', () => {
    const calls: string[][] = []
    const r = provisionNativeVenv({
      ...base,
      exists: transcriberOk, // venv python absent
      exec: makeExec({ pyVersion: 'Python 3.11.9', verifyOk: true, calls }),
    })
    assert.equal(r.status, 'provisioned')
    assert.equal(r.pythonBin, 'python3.11')
    assert.ok(calls.some((c) => c[1] === '-m' && c[2] === 'venv'))
    assert.ok(calls.some((c) => c.includes('parakeet-mlx')))
  })

  it('errors when no suitable Python is found', () => {
    const err = catchErr(() =>
      provisionNativeVenv({ ...base, exists: transcriberOk, exec: makeExec({ verifyOk: true }) }),
    )
    assert.ok(isCompostError(err))
    assert.match((err as Error).message, /Python 3\.11/)
  })

  it('errors (PROVIDER_ERROR) when pip install fails', () => {
    const err = catchErr(() =>
      provisionNativeVenv({
        ...base,
        exists: transcriberOk,
        exec: makeExec({ pyVersion: 'Python 3.11.9', pipOk: false }),
      }),
    ) as Error
    assert.ok(isCompostError(err))
    assert.match(err.message, /pip install failed/)
  })

  it('errors when the transcriber dir cannot be located', () => {
    const err = catchErr(() =>
      provisionNativeVenv({
        env: ENV,
        transcriberDir: '/t',
        exists: () => false,
        exec: makeExec({}),
      }),
    )
    assert.ok(isCompostError(err))
    assert.match((err as Error).message, /transcriber\//)
  })

  it('NATIVE_DEPS stays in sync with the transcriber [native] extra', () => {
    const dir = findRepoTranscriberDir()
    assert.ok(dir, 'repo transcriber dir should resolve in the checkout')
    const toml = readFileSync(join(dir as string, 'pyproject.toml'), 'utf8')
    const block = /native\s*=\s*\[([\s\S]*?)\]/.exec(toml)
    assert.ok(block, 'pyproject must define a [native] extra')
    const fromToml = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(new Set(fromToml), new Set(NATIVE_DEPS))
  })

  it('rejects an out-of-range Python (only 3.11–3.12)', () => {
    for (const ver of ['Python 3.13.0', 'Python 3.10.4']) {
      const err = catchErr(() =>
        provisionNativeVenv({ ...base, exists: transcriberOk, exec: makeExec({ pyVersion: ver }) }),
      )
      assert.ok(isCompostError(err))
      assert.match((err as Error).message, /Python 3\.11/)
    }
  })

  it('errors when deps fail to import after install', () => {
    const err = catchErr(() =>
      provisionNativeVenv({
        ...base,
        exists: transcriberOk, // venv absent → fresh provision, then final verify fails
        exec: makeExec({ pyVersion: 'Python 3.11.9', verifyOk: false }),
      }),
    ) as Error
    assert.ok(isCompostError(err))
    assert.match(err.message, /did not import/)
  })

  it('force reinstalls even when deps already import, with venv --clear', () => {
    const calls: string[][] = []
    const r = provisionNativeVenv({
      ...base,
      force: true,
      exists: (p) => transcriberOk(p) || p === VENV_PY, // venv present + would import
      exec: makeExec({ pyVersion: 'Python 3.11.9', verifyOk: true, calls }),
    })
    assert.equal(r.status, 'provisioned') // force bypasses the already-ready short-circuit
    assert.ok(calls.some((c) => c[1] === '-m' && c[2] === 'venv' && c.includes('--clear')))
  })
})
