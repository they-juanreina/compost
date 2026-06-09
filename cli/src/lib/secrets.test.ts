import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  assertSecretName,
  auditSecretsPerms,
  type KeychainBackend,
  listSecrets,
  loadSecretsEnv,
  parseDotenv,
  readSecretsFile,
  resolveSecret,
  rmSecret,
  secretsEnvPath,
  setSecret,
} from './secrets.js'

const POSIX = process.platform !== 'win32'

/** In-memory keychain so tests never touch the real OS keychain. */
class FakeKeychain implements KeychainBackend {
  readonly label = 'fake keychain'
  store = new Map<string, string>()
  failSet = false
  get(name: string): string | undefined {
    return this.store.get(name)
  }
  set(name: string, value: string): void {
    if (this.failSet) throw new Error('keychain locked')
    this.store.set(name, value)
  }
  del(name: string): boolean {
    return this.store.delete(name)
  }
}

describe('secrets', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'compost-secrets-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  describe('parseDotenv', () => {
    it('parses KEY=value, export, comments, quotes; skips junk', () => {
      const parsed = parseDotenv(
        [
          '# comment',
          '',
          'A=1',
          'export B = two ',
          'C="quoted"',
          "D='q2'",
          'no-eq-line',
          '9BAD=x',
        ].join('\n'),
      )
      assert.deepEqual(parsed, { A: '1', B: 'two', C: 'quoted', D: 'q2' })
    })
  })

  describe('assertSecretName', () => {
    it('accepts env-var names and rejects others', () => {
      assert.doesNotThrow(() => assertSecretName('HUGGINGFACE_TOKEN'))
      assert.throws(() => assertSecretName('9BAD'), /Invalid secret name/)
      assert.throws(() => assertSecretName('has space'), /Invalid secret name/)
    })
  })

  describe('resolveSecret precedence (env > keychain > file)', () => {
    it('prefers env, then keychain, then the 0600 file', () => {
      const kc = new FakeKeychain()
      // File tier:
      setSecret('TOK', 'fromfile', { keychain: null, home })
      // Keychain tier:
      kc.store.set('TOK', 'fromkc')

      // All three present → env wins.
      assert.deepEqual(resolveSecret('TOK', { env: { TOK: 'fromenv' }, keychain: kc, home }), {
        value: 'fromenv',
        source: 'env',
      })
      // No env → keychain wins.
      assert.deepEqual(resolveSecret('TOK', { env: {}, keychain: kc, home }), {
        value: 'fromkc',
        source: 'keychain',
      })
      // No env, no keychain → file.
      assert.deepEqual(resolveSecret('TOK', { env: {}, keychain: null, home }), {
        value: 'fromfile',
        source: 'file',
      })
    })

    it('treats a set-but-blank env var as unset', () => {
      assert.equal(resolveSecret('TOK', { env: { TOK: '   ' }, keychain: null, home }), undefined)
    })

    it('checks aliases (HF_TOKEN alongside HUGGINGFACE_TOKEN)', () => {
      const r = resolveSecret('HUGGINGFACE_TOKEN', {
        env: { HF_TOKEN: 'hf_x' },
        aliases: ['HF_TOKEN'],
        keychain: null,
        home,
      })
      assert.deepEqual(r, { value: 'hf_x', source: 'env' })
    })

    it('returns undefined when set nowhere', () => {
      assert.equal(resolveSecret('NOPE', { env: {}, keychain: null, home }), undefined)
    })
  })

  describe('setSecret', () => {
    it('writes a 0600 file when there is no keychain, and round-trips', () => {
      const res = setSecret('TOK', 'secret-val', { keychain: null, home })
      assert.equal(res.stored_in, 'file')
      const path = secretsEnvPath({ home })
      if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.deepEqual(resolveSecret('TOK', { env: {}, keychain: null, home }), {
        value: 'secret-val',
        source: 'file',
      })
    })

    it('prefers the keychain when one is available', () => {
      const kc = new FakeKeychain()
      const res = setSecret('TOK', 'kc-val', { keychain: kc, home })
      assert.equal(res.stored_in, 'keychain')
      assert.equal(kc.store.get('TOK'), 'kc-val')
    })

    it('falls back to the 0600 file when a keychain write fails', () => {
      const kc = new FakeKeychain()
      kc.failSet = true
      const res = setSecret('TOK', 'val', { keychain: kc, home })
      assert.equal(res.stored_in, 'file')
      assert.match(res.fallback_reason ?? '', /keychain locked/)
      assert.deepEqual(resolveSecret('TOK', { env: {}, keychain: null, home }), {
        value: 'val',
        source: 'file',
      })
    })

    it('rejects empty values and bad names', () => {
      assert.throws(() => setSecret('TOK', '   ', { keychain: null, home }), /empty value/)
      assert.throws(() => setSecret('9BAD', 'x', { keychain: null, home }), /Invalid secret name/)
    })

    it('re-normalizes perms to 0600 when overwriting a loose file', { skip: !POSIX }, () => {
      setSecret('A', '1', { keychain: null, home })
      const path = secretsEnvPath({ home })
      chmodSync(path, 0o644)
      setSecret('B', '2', { keychain: null, home }) // should fix perms + preserve A
      assert.equal(statSync(path).mode & 0o777, 0o600)
      const file = readSecretsFile({ home })
      assert.deepEqual(file.values, { A: '1', B: '2' })
    })
  })

  describe('rmSecret', () => {
    it('removes from keychain and file, leaving env alone', () => {
      const kc = new FakeKeychain()
      setSecret('TOK', 'f', { keychain: null, home })
      kc.store.set('TOK', 'k')
      const res = rmSecret('TOK', { keychain: kc, home })
      assert.deepEqual(res.removed_from.sort(), ['file', 'keychain'])
      assert.equal(kc.store.has('TOK'), false)
      assert.equal(resolveSecret('TOK', { env: {}, keychain: null, home }), undefined)
    })

    it('reports nothing removed when absent', () => {
      const res = rmSecret('GONE', { keychain: null, home })
      assert.deepEqual(res.removed_from, [])
    })
  })

  describe('listSecrets', () => {
    it('reports sources, never values, and includes file-only keys', () => {
      setSecret('HUGGINGFACE_TOKEN', 'hf', { keychain: null, home })
      const { items } = listSecrets({ env: { ANTHROPIC_API_KEY: 'sk' }, keychain: null, home })
      const byName = Object.fromEntries(items.map((i) => [i.name, i.sources]))
      assert.deepEqual(byName.HUGGINGFACE_TOKEN, ['file'])
      assert.deepEqual(byName.ANTHROPIC_API_KEY, ['env'])
      // Never leaks a value.
      assert.equal(JSON.stringify(items).includes('hf'), false)
    })
  })

  describe('insecure-perms refusal', () => {
    it('refuses to read a group/world-readable secrets.env', { skip: !POSIX }, () => {
      setSecret('TOK', 'v', { keychain: null, home })
      chmodSync(secretsEnvPath({ home }), 0o644)
      const read = readSecretsFile({ home })
      assert.equal(read.secure, false)
      assert.deepEqual(read.values, {}) // refused — contents never read
      // And so it doesn't resolve from the file tier.
      assert.equal(resolveSecret('TOK', { env: {}, keychain: null, home }), undefined)
    })
  })

  describe('loadSecretsEnv (startup autoload)', () => {
    it('loads file values into env without overriding already-set vars', () => {
      setSecret('A', 'fileA', { keychain: null, home })
      setSecret('B', 'fileB', { keychain: null, home })
      const env: NodeJS.ProcessEnv = { A: 'envA' } // A already set → must win
      const res = loadSecretsEnv({ env, home })
      assert.equal(res.skipped, null)
      assert.equal(env.A, 'envA') // not overridden
      assert.equal(env.B, 'fileB') // loaded
      assert.deepEqual(res.loaded, ['B'])
    })

    it('reports not-found when there is no file', () => {
      const res = loadSecretsEnv({ env: {}, home })
      assert.equal(res.skipped, 'not-found')
    })

    it('refuses an insecure file and warns', { skip: !POSIX }, () => {
      setSecret('A', '1', { keychain: null, home })
      chmodSync(secretsEnvPath({ home }), 0o644)
      const env: NodeJS.ProcessEnv = {}
      let warned = ''
      const res = loadSecretsEnv({ env, home, warn: (m) => (warned = m) })
      assert.equal(res.skipped, 'insecure-perms')
      assert.equal(env.A, undefined)
      assert.match(warned, /chmod 600/)
    })
  })

  describe('auditSecretsPerms', () => {
    it('returns no issues for a clean 0600 file', { skip: !POSIX }, () => {
      setSecret('TOK', 'v', { keychain: null, home })
      assert.deepEqual(auditSecretsPerms({ home }), [])
    })

    it('flags a group/world-readable secrets.env with a chmod 600 fix', { skip: !POSIX }, () => {
      setSecret('TOK', 'v', { keychain: null, home })
      chmodSync(secretsEnvPath({ home }), 0o644)
      const issues = auditSecretsPerms({ home })
      const sp = secretsEnvPath({ home })
      const issue = issues.find((i) => i.path === sp)
      assert.ok(issue, 'expected an issue for secrets.env')
      assert.equal(issue?.kind, 'file')
      assert.match(issue?.fix ?? '', /chmod 600/)
    })

    it('flags a hand-rolled secret-ish file by path (e.g. hf_token/compost.txt)', {
      skip: !POSIX,
    }, () => {
      const dir = join(home, 'hf_token')
      mkdirSync(dir, { recursive: true })
      const f = join(dir, 'compost.txt')
      writeFileSync(f, 'hf_xxx\n', { mode: 0o644 })
      chmodSync(f, 0o644)
      const issues = auditSecretsPerms({ home })
      assert.ok(issues.some((i) => i.path === f && i.fix.includes('chmod 600')))
    })

    it('is a no-op on win32', () => {
      assert.deepEqual(auditSecretsPerms({ home, platform: 'win32' }), [])
    })
  })
})
