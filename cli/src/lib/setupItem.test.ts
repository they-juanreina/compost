import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { FetchLike } from '../llm/types.js'
import type { rmSecret, setSecret } from './secrets.js'
import { actionsFor, runItem, validateHfToken } from './setupItem.js'

/** Fake fetch with a fixed status + JSON body (the FetchLike response shape). */
function fakeFetch(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

describe('setup item — hf-token lifecycle (the prototype spine)', () => {
  it('renew stores the new token, then live-validates it', async () => {
    const calls: Array<[string, string]> = []
    const storeSecret: typeof setSecret = (name, value) => {
      calls.push([name, value])
      return { name, stored_in: 'keychain', location: 'macOS Keychain' }
    }
    const res = await runItem('hf-token', 'renew', {
      value: 'hf_NEW',
      storeSecret,
      fetchImpl: fakeFetch(200, { name: 'juanreina' }),
    })
    // The whole spine: id dispatch → setSecret reuse → live validity probe.
    assert.deepEqual(calls, [['HUGGINGFACE_TOKEN', 'hf_NEW']])
    assert.equal(res.recheck.status, 'ok')
    assert.match(res.recheck.detail, /juanreina/)
  })

  it('forget refuses to imply success for a GENUINE shell export (nothing local)', async () => {
    let removed = false
    const removeSecret: typeof rmSecret = () => {
      removed = true
      return { name: 'HUGGINGFACE_TOKEN', removed_from: [] }
    }
    // env set, but not stored in our file/keychain → a real shell export.
    const inspect = () => ({ envVal: 'hf_from_shell' })
    const res = await runItem('hf-token', 'forget', { removeSecret, inspect })
    assert.equal(removed, false) // never calls rmSecret — there's nothing local to remove
    assert.equal((res.result as { refused?: boolean }).refused, true)
    assert.match(res.recheck.detail, /shell env/)
  })

  it('forget removes the local copy when the token is keychain-sourced', async () => {
    const removeSecret: typeof rmSecret = () => ({
      name: 'HUGGINGFACE_TOKEN',
      removed_from: ['keychain'],
    })
    const inspect = () => ({ kcVal: 'hf_x' })
    const res = await runItem('hf-token', 'forget', { removeSecret, inspect })
    assert.equal(res.recheck.status, 'ok')
    assert.match((res.result as { remote_action: { url: string } }).remote_action.url, /hf\.co/)
  })

  it('forget removes a FILE token even though the autoloader mirrored it into env', async () => {
    // loadSecretsEnv copies the 0600 file into process.env at startup, so a
    // file-stored token shows up with envVal === fileVal — that must NOT be
    // mistaken for an un-removable shell export (the bug live-testing caught).
    let removedFrom: string[] | null = null
    const removeSecret: typeof rmSecret = () => {
      removedFrom = ['file']
      return { name: 'HUGGINGFACE_TOKEN', removed_from: ['file'] }
    }
    const inspect = () => ({ fileVal: 'hf_local', envVal: 'hf_local' })
    const res = await runItem('hf-token', 'forget', { removeSecret, inspect })
    assert.deepEqual(removedFrom, ['file']) // it DID remove the local file copy
    assert.equal(res.recheck.status, 'ok')
    assert.doesNotMatch(res.recheck.detail, /shell env/)
  })

  it('accepts "revoke" as a familiar alias for forget', async () => {
    const removeSecret: typeof rmSecret = () => ({
      name: 'HUGGINGFACE_TOKEN',
      removed_from: ['keychain'],
    })
    const res = await runItem('hf-token', 'revoke', {
      removeSecret,
      inspect: () => ({ kcVal: 'x' }),
    })
    assert.equal(res.action, 'forget') // normalized to the honest name
    assert.equal(res.recheck.status, 'ok')
  })

  it('validateHfToken maps 401 to fail (revoked/expired)', async () => {
    const v = await validateHfToken('hf_dead', { fetchImpl: fakeFetch(401, {}) })
    assert.equal(v.status, 'fail')
  })

  it('actionsFor exposes the hf-token lifecycle and nothing for unknown ids', () => {
    assert.deepEqual(
      actionsFor('hf-token').map((a) => a.id),
      ['validate', 'renew', 'forget'],
    )
    assert.deepEqual(actionsFor('ollama'), [])
    assert.deepEqual(actionsFor('nonsense'), [])
  })
})

describe('setup item — the model GENERALIZES past the HF token', () => {
  it('model:<name> exposes a pull action and runs `ollama pull <name>`', async () => {
    assert.deepEqual(
      actionsFor('model:bge-m3').map((a) => a.id),
      ['pull'],
    )
    let ran: [string, string[]] | null = null
    const run = (cmd: string, args: string[]) => {
      ran = [cmd, args]
      return { ok: true }
    }
    const res = await runItem('model:bge-m3', 'pull', { run })
    assert.deepEqual(ran, ['ollama', ['pull', 'bge-m3']])
    assert.equal(res.recheck.status, 'ok')
  })

  it('secret-perms:<path> exposes a fix action and chmod 600s the real file', () => {
    return (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'compost-item-'))
      const file = join(dir, 'secrets.env')
      writeFileSync(file, 'HUGGINGFACE_TOKEN=x\n', { mode: 0o644 })
      chmodSync(file, 0o644) // loose on purpose
      assert.deepEqual(
        actionsFor(`secret-perms:${file}`).map((a) => a.id),
        ['fix'],
      )
      const res = await runItem(`secret-perms:${file}`, 'fix')
      assert.equal(res.recheck.status, 'ok')
      assert.equal(statSync(file).mode & 0o777, 0o600) // really tightened on disk
    })()
  })

  it('rejects an unknown action and an unmaintainable id with INVALID_INPUT', async () => {
    await assert.rejects(() => runItem('hf-token', 'frobnicate'), /Unknown action/)
    await assert.rejects(() => runItem('model:bge-m3', 'forget'), /Unknown action/)
    await assert.rejects(() => runItem('ollama', 'renew'), /No maintainable item/)
  })
})
