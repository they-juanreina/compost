import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  diagnoseNativeRuntime,
  findRepoTranscriberDir,
  pickRuntime,
  resolveNativeRuntime,
} from './nativeRuntime.js'

const PATHS = { python: '/p', transcriberDir: '/t' }

describe('nativeRuntime', () => {
  describe('pickRuntime', () => {
    it('honors an explicit runtime regardless of platform/resolution', () => {
      assert.equal(pickRuntime('docker', PATHS, true), 'docker')
      assert.equal(pickRuntime('native', null, false), 'native') // explicit; errors later if unresolved
    })
    it('defaults to native on Apple Silicon when native resolves', () => {
      assert.equal(pickRuntime(undefined, PATHS, true), 'native')
    })
    it('defaults to docker when native is unresolved or off Apple Silicon', () => {
      assert.equal(pickRuntime(undefined, null, true), 'docker')
      assert.equal(pickRuntime(undefined, PATHS, false), 'docker')
    })
  })

  describe('resolveNativeRuntime', () => {
    it('prefers explicit over env over discovery', () => {
      const r = resolveNativeRuntime({
        python: '/x/py',
        transcriberDir: '/x/t',
        env: { COMPOST_TRANSCRIBER_PYTHON: '/env/py', COMPOST_TRANSCRIBER_DIR: '/env/t' },
        exists: () => false,
      })
      assert.deepEqual(r, { python: '/x/py', transcriberDir: '/x/t' })
    })
    it('uses env vars when no explicit flags', () => {
      const r = resolveNativeRuntime({
        env: { COMPOST_TRANSCRIBER_PYTHON: '/env/py', COMPOST_TRANSCRIBER_DIR: '/env/t' },
        exists: () => false,
      })
      assert.deepEqual(r, { python: '/env/py', transcriberDir: '/env/t' })
    })
    it('falls back to the managed venv + repo dir when present', () => {
      const r = resolveNativeRuntime({
        env: { COMPOST_HOME: '/home/.compost' },
        exists: () => true,
        repoTranscriberDir: () => '/repo/transcriber',
      })
      assert.equal(r?.python, '/home/.compost/transcriber-venv/bin/python')
      assert.equal(r?.transcriberDir, '/repo/transcriber')
    })
    it('returns null when python or transcriber dir cannot be resolved', () => {
      assert.equal(
        resolveNativeRuntime({ env: {}, exists: () => false, repoTranscriberDir: () => undefined }),
        null,
      )
      assert.equal(
        resolveNativeRuntime({
          python: '/p',
          env: {},
          exists: () => false,
          repoTranscriberDir: () => undefined,
        }),
        null,
      )
    })
  })

  // The doctor (#207) needs to distinguish "venv missing" from "transcriber
  // source missing" so it can give the right remediation. diagnoseNativeRuntime
  // returns each piece independently (and its source), instead of collapsing
  // both gaps into a single null like resolveNativeRuntime.
  describe('diagnoseNativeRuntime (#207)', () => {
    it('returns both paths + sources when fully resolvable', () => {
      const d = diagnoseNativeRuntime({
        env: { COMPOST_TRANSCRIBER_PYTHON: '/env/py', COMPOST_TRANSCRIBER_DIR: '/env/t' },
        exists: () => false,
      })
      assert.deepEqual(d, {
        python: '/env/py',
        transcriberDir: '/env/t',
        pythonSource: 'env',
        transcriberDirSource: 'env',
      })
    })

    it('reports venv via managed-venv source when only that exists', () => {
      const d = diagnoseNativeRuntime({
        env: { COMPOST_HOME: '/home/.compost' },
        exists: (p) => p === '/home/.compost/transcriber-venv/bin/python',
        repoTranscriberDir: () => undefined,
      })
      assert.equal(d.python, '/home/.compost/transcriber-venv/bin/python')
      assert.equal(d.pythonSource, 'managed-venv')
      assert.equal(d.transcriberDir, undefined)
      assert.equal(d.transcriberDirSource, undefined)
    })

    it('reports transcriberDir via repo-walk source when only that exists', () => {
      const d = diagnoseNativeRuntime({
        env: {},
        exists: () => false,
        repoTranscriberDir: () => '/repo/transcriber',
      })
      assert.equal(d.python, undefined)
      assert.equal(d.transcriberDir, '/repo/transcriber')
      assert.equal(d.transcriberDirSource, 'repo-walk')
    })

    it('reports both undefined cleanly when nothing resolves', () => {
      const d = diagnoseNativeRuntime({
        env: {},
        exists: () => false,
        repoTranscriberDir: () => undefined,
      })
      assert.deepEqual(d, {})
    })

    it('explicit args take precedence and their source is "explicit"', () => {
      const d = diagnoseNativeRuntime({
        python: '/x/py',
        transcriberDir: '/x/t',
        env: { COMPOST_TRANSCRIBER_PYTHON: '/env/py', COMPOST_TRANSCRIBER_DIR: '/env/t' },
        exists: () => false,
      })
      assert.equal(d.pythonSource, 'explicit')
      assert.equal(d.transcriberDirSource, 'explicit')
    })
  })

  describe('findRepoTranscriberDir', () => {
    it('finds transcriber/ by walking up from the module dir', () => {
      const exists = (p: string) => p === '/repo/transcriber/app/transcribe_cli.py'
      assert.equal(findRepoTranscriberDir('/repo/cli/dist/lib', exists), '/repo/transcriber')
    })
    it('returns undefined when not found (e.g. a bare global install)', () => {
      assert.equal(
        findRepoTranscriberDir('/usr/local/lib/node_modules/compost', () => false),
        undefined,
      )
    })
  })
})
