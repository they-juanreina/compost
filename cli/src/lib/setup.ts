import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveFetch } from '../llm/http.js'
import type { FetchLike } from '../llm/types.js'
import { isAppleSilicon, resolveNativeRuntime } from './nativeRuntime.js'

const execFileAsync = promisify(execFile)

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface SetupCheck {
  /** Stable id, e.g. "ollama", "pyannote-license". */
  id: string
  /** Human one-liner. */
  label: string
  status: CheckStatus
  /** What we observed. */
  detail: string
  /** Copy-pasteable command(s) to fix it, or null when ok. */
  fix: string | null
}

export interface SetupReport {
  schema_version: '1.0'
  ready: boolean // true when no `fail` checks (warns are tolerated)
  checks: SetupCheck[]
}

export interface SetupDeps {
  cwd?: string
  fetchImpl?: FetchLike
  /** Injectable command runner (for docker/ollama CLI probes + tests). */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; ok: boolean }>
  env?: NodeJS.ProcessEnv
  /** Ollama base URL (default http://localhost:11434). */
  ollamaUrl?: string
  /** Transcriber base URL (default http://localhost:7862). */
  transcriberUrl?: string
  /** Embedding models the embed-worker needs present in Ollama. */
  requiredOllamaModels?: string[]
  /** Override Apple-Silicon detection (tests). Defaults to the host arch. */
  appleSilicon?: boolean
}

const PYANNOTE_GATED_REPOS = ['pyannote/speaker-diarization-3.1', 'pyannote/segmentation-3.0']

const DEFAULT_REQUIRED_MODELS = ['bge-m3']

const defaultExec = async (cmd: string, args: string[]) => {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 })
    return { stdout, ok: true }
  } catch (err) {
    const e = err as { stdout?: string }
    return { stdout: e.stdout ?? '', ok: false }
  }
}

/**
 * Run every prerequisite probe and return a checklist. Read-only: probes,
 * never installs. The `/compost-setup` skill reads this JSON and offers to run
 * the `fix` commands with the researcher's confirmation — the CLI stays
 * deterministic and side-effect-free so it's safe for agents and CI.
 */
export async function runSetup(deps: SetupDeps = {}): Promise<SetupReport> {
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const fetchImpl = resolveFetch(deps.fetchImpl)
  const exec = deps.exec ?? defaultExec
  const ollamaUrl = (deps.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '')
  const transcriberUrl = (deps.transcriberUrl ?? 'http://localhost:7862').replace(/\/$/, '')
  const requiredModels = deps.requiredOllamaModels ?? DEFAULT_REQUIRED_MODELS

  const checks: SetupCheck[] = []

  // 1. Ollama reachable + 2. required models present (one probe, two checks).
  let ollamaTags: string[] | null = null
  try {
    const res = await fetchImpl(`${ollamaUrl}/api/tags`, { method: 'GET' })
    if (res.ok) {
      const json = (await res.json()) as { models?: Array<{ name?: string }> }
      ollamaTags = (json.models ?? []).map((m) => m.name ?? '')
    }
  } catch {
    ollamaTags = null
  }
  if (ollamaTags === null) {
    checks.push({
      id: 'ollama',
      label: 'Ollama running',
      status: 'fail',
      detail: `No response at ${ollamaUrl}/api/tags`,
      fix: 'Install from ollama.com, then run `ollama serve` (or open the app).',
    })
  } else {
    checks.push({
      id: 'ollama',
      label: 'Ollama running',
      status: 'ok',
      detail: `${ollamaTags.length} models installed`,
      fix: null,
    })
    for (const model of requiredModels) {
      const present = ollamaTags.some((t) => t === model || t.startsWith(`${model}:`))
      checks.push(
        present
          ? {
              id: `model:${model}`,
              label: `Model ${model}`,
              status: 'ok',
              detail: 'installed',
              fix: null,
            }
          : {
              id: `model:${model}`,
              label: `Model ${model}`,
              status: 'fail',
              detail: 'not installed (embeddings will fail)',
              fix: `ollama pull ${model}`,
            },
      )
    }
  }

  // 3. Docker / OrbStack.
  const docker = await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
  checks.push(
    docker.ok
      ? {
          id: 'docker',
          label: 'Docker/OrbStack',
          status: 'ok',
          detail: `daemon ${docker.stdout.trim()}`,
          fix: null,
        }
      : {
          id: 'docker',
          label: 'Docker/OrbStack',
          status: 'warn',
          detail: 'daemon unreachable (only the cross-platform transcription fallback needs it)',
          fix: 'Install OrbStack (orbstack.dev) or Docker Desktop, then start it.',
        },
  )

  // 4. Transcriber container.
  let transcriberOk = false
  try {
    const res = await fetchImpl(`${transcriberUrl}/health`, { method: 'GET' })
    transcriberOk = res.ok
  } catch {
    transcriberOk = false
  }
  checks.push(
    transcriberOk
      ? {
          id: 'transcriber',
          label: 'Transcriber service',
          status: 'ok',
          detail: `healthy at ${transcriberUrl}`,
          fix: null,
        }
      : {
          id: 'transcriber',
          label: 'Transcriber service',
          status: 'warn',
          detail: 'not reachable (cross-platform fallback; native is the default on Apple Silicon)',
          fix: 'docker compose -f transcriber/compose.yaml up --build -d',
        },
  )

  // 4b. Native transcription (Apple Silicon, #176) — the default fast path.
  if (deps.appleSilicon ?? isAppleSilicon()) {
    const native = resolveNativeRuntime({ env })
    if (native === null) {
      checks.push({
        id: 'native-transcribe',
        label: 'Native transcription',
        status: 'warn',
        detail: 'no native venv resolved (Apple Silicon runs ~20× faster than the Docker fallback)',
        fix: 'compost setup --provision-native  (or set COMPOST_TRANSCRIBER_PYTHON + COMPOST_TRANSCRIBER_DIR)',
      })
    } else {
      const probe = await exec(native.python, ['-c', 'import parakeet_mlx, pyannote.audio'])
      checks.push(
        probe.ok
          ? {
              id: 'native-transcribe',
              label: 'Native transcription',
              status: 'ok',
              detail: `parakeet-mlx + pyannote ready (${native.python})`,
              fix: null,
            }
          : {
              id: 'native-transcribe',
              label: 'Native transcription',
              status: 'warn',
              detail: `venv at ${native.python} is missing deps (parakeet-mlx / pyannote)`,
              fix: `${native.python} -m pip install parakeet-mlx pyannote.audio silero-vad`,
            },
      )
    }
  }

  // 5. HuggingFace token present.
  const hfToken = env.HUGGINGFACE_TOKEN || env.HF_TOKEN
  if (!hfToken) {
    checks.push({
      id: 'hf-token',
      label: 'HuggingFace token',
      status: 'warn',
      detail: 'HUGGINGFACE_TOKEN not set (needed for pyannote diarization)',
      fix: 'Create a token at hf.co/settings/tokens, then export HUGGINGFACE_TOKEN=hf_…',
    })
  } else {
    checks.push({
      id: 'hf-token',
      label: 'HuggingFace token',
      status: 'ok',
      detail: 'set',
      fix: null,
    })
    // 6. pyannote license — must be a FILE fetch, not a metadata ping (the
    // /api/models endpoint returns 200 even when the license isn't accepted).
    for (const repo of PYANNOTE_GATED_REPOS) {
      let accepted = false
      try {
        const res = await fetchImpl(`https://huggingface.co/${repo}/resolve/main/config.yaml`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${hfToken}` },
        })
        accepted = res.ok
      } catch {
        accepted = false
      }
      checks.push(
        accepted
          ? {
              id: `pyannote:${repo}`,
              label: `pyannote license: ${repo}`,
              status: 'ok',
              detail: 'accepted',
              fix: null,
            }
          : {
              id: `pyannote:${repo}`,
              label: `pyannote license: ${repo}`,
              status: 'warn',
              detail: 'license not accepted (403 on the gated model file)',
              fix: `Accept at https://huggingface.co/${repo} (logged in as the token's account)`,
            },
      )
    }
  }

  // 7. Seeds/ directory present.
  const seedsDir = resolve(cwd, 'Seeds')
  checks.push(
    existsSync(seedsDir)
      ? { id: 'seeds', label: 'Seeds/ directory', status: 'ok', detail: seedsDir, fix: null }
      : {
          id: 'seeds',
          label: 'Seeds/ directory',
          status: 'warn',
          detail: `No Seeds/ under ${cwd}`,
          fix: 'compost init <name>  (or run from a directory that has a Seeds/ tree)',
        },
  )

  // 8. config.toml parses for at least one seed (best-effort; skipped if no Seeds).
  if (existsSync(seedsDir)) {
    const anyConfig = firstSeedConfig(seedsDir)
    checks.push(
      anyConfig
        ? { id: 'config', label: 'config.toml', status: 'ok', detail: anyConfig, fix: null }
        : {
            id: 'config',
            label: 'config.toml',
            status: 'warn',
            detail: 'no seed has a .compost/config.toml yet',
            fix: 'compost init <name>  (scaffolds .compost/config.toml)',
          },
    )
  }

  const ready = checks.every((c) => c.status !== 'fail')
  return { schema_version: '1.0', ready, checks }
}

function firstSeedConfig(seedsDir: string): string | null {
  // Cheap: return the path of the first seed config we find; full parse is the
  // `compost config show` command's job.
  try {
    for (const entry of readdirSync(seedsDir)) {
      if (entry.startsWith('.')) continue
      const cfg = join(seedsDir, entry, '.compost', 'config.toml')
      if (existsSync(cfg)) return cfg
    }
  } catch {
    // ignore
  }
  return null
}
