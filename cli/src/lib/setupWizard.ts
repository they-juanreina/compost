import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveFetch } from '../llm/http.js'
import type { FetchLike } from '../llm/types.js'
import { loadConfig, saveConfig, setConfigValue } from './config.js'
import { diagnoseNativeRuntime, isAppleSilicon } from './nativeRuntime.js'
import { provisionNativeVenv } from './provisionNative.js'
import { setSecret } from './secrets.js'
import { runSetup, type SetupCheck, type SetupReport } from './setup.js'
import { saveUserConfig } from './userConfig.js'

/** Per-task routes the wizard writes for each chat-model choice. The local
 * default matches the seed template's quick_chat model; the cloud routes keep
 * the template's synthesis model and add a fast model for the local tasks. */
export const LOCAL_CHAT_MODEL = 'llama3.1:8b'
export const CLOUD_FAST_MODEL = 'anthropic:claude-haiku-4-5'
export const CLOUD_SYNTHESIS_MODEL = 'anthropic:claude-opus-4-7'

const PYANNOTE_GATED_REPOS = ['pyannote/speaker-diarization-3.1', 'pyannote/segmentation-3.0']

export interface WizardIO {
  say(text: string): void
  /** Yes/no with a default. */
  confirm(question: string, def: boolean): Promise<boolean>
  /** Free-text with a default shown in brackets. */
  ask(question: string, def?: string): Promise<string>
  /** Input that must not echo (tokens, API keys). Empty string = skipped. */
  askHidden(question: string): Promise<string>
}

export interface WizardDeps {
  io: WizardIO
  cwd?: string
  env?: NodeJS.ProcessEnv
  appleSilicon?: boolean
  fetchImpl?: FetchLike
  /** Diagnostic pass (injectable for tests). */
  check?: typeof runSetup
  /** Run a streaming shell command the user just confirmed (install, pull). */
  run?: (cmd: string, args: string[]) => { ok: boolean }
  provision?: typeof provisionNativeVenv
  storeSecret?: typeof setSecret
  saveDefaults?: typeof saveUserConfig
  /** Existing seed dirs whose config.toml the wizard offers to update. */
  listSeeds?: () => string[]
}

export interface WizardResult {
  report: SetupReport
  actions: string[]
}

function checkById(report: SetupReport, id: string): SetupCheck | undefined {
  return report.checks.find((c) => c.id === id)
}

function notOk(report: SetupReport, id: string): boolean {
  const c = checkById(report, id)
  return c !== undefined && c.status !== 'ok'
}

function statusGlyph(c: SetupCheck): string {
  return c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'
}

function printReport(io: WizardIO, report: SetupReport): void {
  for (const c of report.checks) {
    io.say(`  ${statusGlyph(c)} ${c.label} — ${c.detail}`)
  }
}

/**
 * Guided setup: walk every fixable gap with a per-step confirmed fix, collect
 * the secrets the pipeline needs (HF token, optional LLM key), and let the
 * user pick how `compost chat` should run on this machine. Every mutation is
 * proposed before it runs; declining any step just moves on. The non-TTY
 * `compost setup` diagnostic is unchanged — this runs only at a terminal.
 */
export async function runSetupWizard(deps: WizardDeps): Promise<WizardResult> {
  const io = deps.io
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const apple = deps.appleSilicon ?? isAppleSilicon()
  const check = deps.check ?? runSetup
  const run = deps.run ?? (() => ({ ok: false }))
  const provision = deps.provision ?? provisionNativeVenv
  const storeSecret = deps.storeSecret ?? setSecret
  const saveDefaults = deps.saveDefaults ?? saveUserConfig
  const fetchImpl = resolveFetch(deps.fetchImpl)
  const actions: string[] = []

  io.say('compost setup — guided')
  io.say(
    `platform: ${process.platform}/${process.arch}${apple ? ' (native transcription)' : ' (Docker transcription fallback)'}`,
  )
  io.say('')
  let report = await check({ cwd, env })
  printReport(io, report)
  io.say('')

  // ── Outdated install: fix this first — everything else may be its symptom ─
  if (notOk(report, 'version')) {
    const detail = checkById(report, 'version')?.detail ?? ''
    io.say(`This install is outdated (${detail}).`)
    if (
      await io.confirm('Upgrade now (npm install -g @they-juanreina/compost-cli@latest)?', true)
    ) {
      const ok = run('npm', ['install', '-g', '@they-juanreina/compost-cli@latest']).ok
      actions.push(
        ok ? 'upgraded CLI — rerun `compost setup` on the new version' : 'upgrade failed',
      )
      if (ok) {
        io.say('Upgraded. Rerun `compost setup` so the new version takes it from here.')
        return { report, actions }
      }
    }
  }

  // ── Ollama: the embeddings (and optionally chat) engine ──────────────────
  if (notOk(report, 'ollama')) {
    io.say('Ollama powers search embeddings and local chat. It is not running.')
    const brewAvailable = process.platform === 'darwin' && run('which', ['brew']).ok
    if (brewAvailable) {
      if (await io.confirm('Install and start Ollama via Homebrew (brew install ollama)?', true)) {
        const installed = run('brew', ['install', 'ollama']).ok
        const started = installed && run('brew', ['services', 'start', 'ollama']).ok
        actions.push(
          started ? 'installed + started Ollama' : 'Ollama install attempted — check output above',
        )
      }
    } else {
      io.say(
        'Install it from https://ollama.com/download, then open the app (or run `ollama serve`).',
      )
    }
  }

  // ── Embedding model ───────────────────────────────────────────────────────
  if (notOk(report, 'model:bge-m3')) {
    if (await io.confirm('Pull the embedding model bge-m3 (~1.2 GB)?', true)) {
      const ok = run('ollama', ['pull', 'bge-m3']).ok
      actions.push(ok ? 'pulled bge-m3' : 'bge-m3 pull failed — is Ollama running?')
    }
  }

  // ── Transcription engine (also required for PDF/document ingest) ─────────
  if (apple && notOk(report, 'native-transcribe')) {
    io.say('')
    io.say(
      'Transcription runs natively on Apple Silicon (the same engine also ingests PDFs and documents).',
    )
    if (
      await io.confirm(
        'Provision the native engine now (downloads ~1 GB of Python wheels, a few minutes)?',
        true,
      )
    ) {
      try {
        const result = provision({})
        actions.push(`native engine: ${result.status}`)
      } catch (err) {
        io.say(`  provisioning failed: ${err instanceof Error ? err.message : err}`)
        actions.push('native provisioning failed')
      }
    }
  } else if (!apple && notOk(report, 'transcriber')) {
    const transcriberDir = diagnoseNativeRuntime({ env }).transcriberDir
    if (transcriberDir !== undefined && existsSync(join(transcriberDir, 'compose.yaml'))) {
      io.say('')
      io.say('Transcription (and PDF/document ingest) runs in Docker on this platform.')
      if (
        await io.confirm(
          'Build and start the transcriber container (first build downloads several GB)?',
          true,
        )
      ) {
        const ok = run('docker', [
          'compose',
          '-f',
          join(transcriberDir, 'compose.yaml'),
          'up',
          '--build',
          '-d',
        ]).ok
        actions.push(
          ok ? 'transcriber container started' : 'docker compose failed — is Docker running?',
        )
      }
    } else {
      io.say(
        'Could not locate the bundled transcriber sources — reinstall @they-juanreina/compost-cli.',
      )
    }
  }

  // ── HuggingFace token (audio diarization only) ────────────────────────────
  if (notOk(report, 'hf-token')) {
    io.say('')
    io.say(
      'Audio transcription labels who is speaking (diarization), which needs a free HuggingFace account:',
    )
    io.say('  1. Token:    https://hf.co/settings/tokens  (a "read" token is enough)')
    io.say('  2. Licenses: accept on BOTH model pages, logged in as the same account —')
    for (const repo of PYANNOTE_GATED_REPOS) io.say(`       https://huggingface.co/${repo}`)
    io.say(
      'PDF and document ingest do not need this — Enter skips, and `compost setup` can add it later.',
    )
    const token = (await io.askHidden('HuggingFace token (hidden, Enter to skip): ')).trim()
    if (token !== '') {
      const stored = storeSecret('HUGGINGFACE_TOKEN', token)
      actions.push(`HF token stored in ${stored.stored_in}`)
      for (const repo of PYANNOTE_GATED_REPOS) {
        let accepted = false
        try {
          const res = await fetchImpl(`https://huggingface.co/${repo}/resolve/main/config.yaml`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          })
          accepted = res.ok
        } catch {
          accepted = false
        }
        io.say(
          accepted
            ? `  ✓ license accepted: ${repo}`
            : `  ! license NOT accepted yet: https://huggingface.co/${repo}`,
        )
      }
    }
  }

  // ── Chat model: how should `compost chat` answer on this machine? ────────
  io.say('')
  io.say('`compost chat` answers questions from your transcripts. Pick how it should run:')
  io.say(`  [1] local — pull ${LOCAL_CHAT_MODEL} (~5 GB) and run offline via Ollama`)
  io.say('  [2] cloud — use an Anthropic API key (best quality; sends excerpts to the API)')
  io.say('  [3] skip for now')
  const choice = (await io.ask('Choice', '1')).trim()
  let routes: Record<string, string> | null = null
  if (choice === '1') {
    const model = (await io.ask('Local model to pull', LOCAL_CHAT_MODEL)).trim() || LOCAL_CHAT_MODEL
    const ok = run('ollama', ['pull', model]).ok
    if (ok) {
      routes = {
        quick_chat: `ollama:${model}`,
        verification: `ollama:${model}`,
        synthesis: `ollama:${model}`,
      }
      actions.push(`chat: local via ollama:${model}`)
      io.say(
        '  (cloud-quality synthesis can be added any time: rerun `compost setup` and pick cloud.)',
      )
    } else {
      io.say(`  pull failed — is Ollama running? Rerun \`compost setup\` to retry.`)
    }
  } else if (choice === '2') {
    const key = (await io.askHidden('Anthropic API key (hidden): ')).trim()
    if (key !== '') {
      const stored = storeSecret('ANTHROPIC_API_KEY', key)
      routes = {
        quick_chat: CLOUD_FAST_MODEL,
        verification: CLOUD_FAST_MODEL,
        synthesis: CLOUD_SYNTHESIS_MODEL,
      }
      actions.push(`chat: cloud (key in ${stored.stored_in})`)
    }
  }

  if (routes !== null) {
    const path = saveDefaults({ defaults: routes }, env)
    io.say(`  routing saved to ${path} — new seeds inherit it automatically.`)
    const seeds = (deps.listSeeds ?? (() => []))()
    for (const seedPath of seeds) {
      if (await io.confirm(`Update model routing in the existing seed ${seedPath}?`, true)) {
        const raw = loadConfig(seedPath).raw
        for (const [task, route] of Object.entries(routes)) {
          setConfigValue(raw, `defaults.${task}`, route)
        }
        saveConfig(seedPath, raw)
        actions.push(`updated routing: ${seedPath}`)
      }
    }
  }

  // ── Re-check and summarize ────────────────────────────────────────────────
  io.say('')
  report = await check({ cwd, env })
  printReport(io, report)
  io.say('')
  io.say(
    report.ready
      ? 'Ready. Next steps:'
      : 'Some checks still need attention (see above). Next steps:',
  )
  io.say('  compost init <study-name>     # create a study')
  io.say('  open Seeds/<study-name>/sessions/_inbox    # drop a recording or PDF in')
  io.say('  compost watch --once          # process it')
  return { report, actions }
}
