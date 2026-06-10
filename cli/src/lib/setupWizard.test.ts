import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SetupCheck, SetupReport } from './setup.js'
import { LOCAL_CHAT_MODEL, runSetupWizard, type WizardIO } from './setupWizard.js'

function check(id: string, status: SetupCheck['status']): SetupCheck {
  return { id, label: id, status, detail: `${id} ${status}`, fix: status === 'ok' ? null : 'fix' }
}

function report(...checks: SetupCheck[]): SetupReport {
  return { schema_version: '1.0', ready: checks.every((c) => c.status !== 'fail'), checks }
}

/** Scripted IO: confirms everything, answers prompts from a queue, records output. */
function scriptedIO(answers: { ask?: string[]; hidden?: string[]; confirm?: boolean }) {
  const said: string[] = []
  const asks = [...(answers.ask ?? [])]
  const hiddens = [...(answers.hidden ?? [])]
  const io: WizardIO = {
    say: (t) => {
      said.push(t)
    },
    confirm: async () => answers.confirm ?? true,
    ask: async (_q, def) => asks.shift() ?? def ?? '',
    askHidden: async () => hiddens.shift() ?? '',
  }
  return { io, said }
}

describe('runSetupWizard', () => {
  it('runs confirmed fixes for missing Ollama model and skips healthy checks', async () => {
    const ran: string[][] = []
    const { io } = scriptedIO({ ask: ['3'] }) // skip the chat-model step
    const result = await runSetupWizard({
      io,
      appleSilicon: true,
      check: async () =>
        report(
          check('ollama', 'ok'),
          check('model:bge-m3', 'fail'),
          check('native-transcribe', 'ok'),
          check('hf-token', 'ok'),
        ),
      run: (cmd, args) => {
        ran.push([cmd, ...args])
        return { ok: true }
      },
      storeSecret: () => {
        throw new Error('no secret should be stored')
      },
      saveDefaults: () => {
        throw new Error('no routing should be saved when skipped')
      },
    })
    assert.deepEqual(ran, [['ollama', 'pull', 'bge-m3']])
    assert.deepEqual(result.actions, ['pulled bge-m3'])
  })

  it('stores the HF token and verifies both pyannote licenses with it', async () => {
    const stored: Array<[string, string]> = []
    const fetched: string[] = []
    const { io, said } = scriptedIO({ ask: ['3'], hidden: ['hf_secret123'] })
    await runSetupWizard({
      io,
      appleSilicon: true,
      check: async () =>
        report(
          check('ollama', 'ok'),
          check('model:bge-m3', 'ok'),
          check('native-transcribe', 'ok'),
          check('hf-token', 'warn'),
        ),
      run: () => ({ ok: true }),
      fetchImpl: (async (url: unknown) => {
        fetched.push(String(url))
        return { ok: String(url).includes('speaker-diarization') }
      }) as unknown as Parameters<typeof runSetupWizard>[0]['fetchImpl'],
      storeSecret: (name, value) => {
        stored.push([name, value])
        return { name, stored_in: 'keychain', location: 'login keychain' }
      },
      saveDefaults: () => {
        throw new Error('routing skipped')
      },
    })
    assert.deepEqual(stored, [['HUGGINGFACE_TOKEN', 'hf_secret123']])
    assert.equal(fetched.length, 2)
    assert.ok(said.some((s) => s.includes('✓ license accepted: pyannote/speaker-diarization-3.1')))
    assert.ok(said.some((s) => s.includes('! license NOT accepted yet')))
  })

  it('local chat choice pulls the model and saves routing for all three tasks', async () => {
    let savedDefaults: Record<string, string> | undefined
    const ran: string[][] = []
    const { io } = scriptedIO({ ask: ['1', ''] }) // choice 1, default model
    await runSetupWizard({
      io,
      appleSilicon: true,
      check: async () =>
        report(
          check('ollama', 'ok'),
          check('model:bge-m3', 'ok'),
          check('native-transcribe', 'ok'),
          check('hf-token', 'ok'),
        ),
      run: (cmd, args) => {
        ran.push([cmd, ...args])
        return { ok: true }
      },
      storeSecret: () => {
        throw new Error('local choice stores no secret')
      },
      saveDefaults: (cfg) => {
        savedDefaults = cfg.defaults
        return '/fake/.compost/config.toml'
      },
    })
    assert.deepEqual(ran, [['ollama', 'pull', LOCAL_CHAT_MODEL]])
    assert.deepEqual(savedDefaults, {
      quick_chat: `ollama:${LOCAL_CHAT_MODEL}`,
      verification: `ollama:${LOCAL_CHAT_MODEL}`,
      synthesis: `ollama:${LOCAL_CHAT_MODEL}`,
    })
  })

  it('maintain step renews an already-set token via runItem (returning-user path)', async () => {
    const stored: Array<[string, string]> = []
    // chat step: skip (3); then maintain: item 1 (hf-token), action 2 (renew), new value.
    const { io, said } = scriptedIO({ ask: ['3', '1', '2'], hidden: ['hf_NEW2'] })
    await runSetupWizard({
      io,
      appleSilicon: true,
      // hf-token already ok → the gap-driven walk never prompts for it; only the
      // maintain step can touch a set token. No model:* check → hf-token is item 1.
      check: async () =>
        report(check('ollama', 'ok'), check('native-transcribe', 'ok'), check('hf-token', 'ok')),
      run: () => ({ ok: true }),
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        statusText: '',
        json: async () => ({ name: 'tester' }),
        text: async () => '',
      })) as unknown as Parameters<typeof runSetupWizard>[0]['fetchImpl'],
      storeSecret: (name, value) => {
        stored.push([name, value])
        return { name, stored_in: 'keychain', location: 'login keychain' }
      },
      saveDefaults: () => {
        throw new Error('chat step skipped')
      },
    })
    assert.deepEqual(stored, [['HUGGINGFACE_TOKEN', 'hf_NEW2']])
    assert.ok(said.some((s) => s.includes('renew') && s.includes('tester')))
  })

  it('cloud chat choice stores the key and routes to anthropic models', async () => {
    const stored: string[] = []
    let savedDefaults: Record<string, string> | undefined
    const { io } = scriptedIO({ ask: ['2'], hidden: ['sk-ant-test'] })
    await runSetupWizard({
      io,
      appleSilicon: true,
      check: async () =>
        report(
          check('ollama', 'ok'),
          check('model:bge-m3', 'ok'),
          check('native-transcribe', 'ok'),
          check('hf-token', 'ok'),
        ),
      run: () => ({ ok: true }),
      storeSecret: (name) => {
        stored.push(name)
        return { name, stored_in: 'keychain', location: 'login keychain' }
      },
      saveDefaults: (cfg) => {
        savedDefaults = cfg.defaults
        return '/fake/.compost/config.toml'
      },
    })
    assert.deepEqual(stored, ['ANTHROPIC_API_KEY'])
    assert.equal(savedDefaults?.quick_chat, 'anthropic:claude-haiku-4-5')
    assert.equal(savedDefaults?.synthesis, 'anthropic:claude-opus-4-7')
  })
})
