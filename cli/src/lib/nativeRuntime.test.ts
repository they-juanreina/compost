import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findRepoTranscriberDir, pickRuntime, resolveNativeRuntime } from './nativeRuntime.js'

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
