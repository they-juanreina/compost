import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CompostError } from '../errors.js'
import { scrubbedEnv } from './childEnv.js'
import { findRepoTranscriberDir, managedVenvDir } from './nativeRuntime.js'

/**
 * Provision the managed native transcription venv (#183) so `compost transcribe`
 * runs native (Parakeet + pyannote on Metal) with zero flags on a fresh
 * Apple-Silicon machine. Side-effectful, so it's an explicit opt-in
 * (`compost setup --provision-native`), separate from the read-only doctor.
 *
 * The dep list mirrors the transcriber's `[native]` extra in pyproject.toml; a
 * unit test asserts they stay in sync. We install the deps (not the package
 * editable) to avoid depending on a build backend — the `app` package is found
 * at run time via the entrypoint's cwd.
 */

/** Native ASR deps — keep in sync with transcriber/pyproject.toml `[native]`. */
export const NATIVE_DEPS = [
  'parakeet-mlx',
  'pyannote.audio>=3.3',
  'silero-vad',
  'torchaudio>=2.3',
  'ffmpeg-python',
]

const PY_CANDIDATES = ['python3.11', 'python3.12', 'python3']
const VERIFY_IMPORTS = 'import parakeet_mlx, pyannote.audio, silero_vad, torchaudio'
const MIN_MINOR = 11
const MAX_MINOR = 12 // transcriber requires-python = >=3.11,<3.13

export interface ProvisionExecResult {
  ok: boolean
  stdout: string
  stderr: string
}
/** Injectable command runner. `stream` lets the slow pip step write to the
 * terminal instead of being captured. */
export type ProvisionExec = (
  cmd: string,
  args: string[],
  opts?: { stream?: boolean },
) => ProvisionExecResult

export interface ProvisionNativeOptions {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  exec?: ProvisionExec
  /** Explicit interpreter to build the venv from (else discovered). */
  pythonBin?: string
  /** transcriber/ dir (else COMPOST_TRANSCRIBER_DIR env or repo-relative). */
  transcriberDir?: string
  /** Reinstall even if the venv already imports the native deps. */
  force?: boolean
}

export interface ProvisionNativeResult {
  status: 'already-ready' | 'provisioned'
  venvDir: string
  venvPython: string
  pythonBin: string | null
  transcriberDir: string
  steps: string[]
}

const defaultExec: ProvisionExec = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    // pip/venv provisioning needs no compost secrets — scrub them (#236).
    env: scrubbedEnv(),
    // stream → live stdout (download progress) but still capture stderr so a
    // failure has a diagnostic (inheriting stderr would null it out).
    stdio: opts?.stream ? ['ignore', 'inherit', 'pipe'] : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { ok: !res.error && res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function pyVersion(exec: ProvisionExec, bin: string): [number, number] | null {
  const r = exec(bin, ['--version'])
  if (!r.ok) return null
  const m = /Python (\d+)\.(\d+)/.exec(`${r.stdout} ${r.stderr}`)
  return m ? [Number(m[1]), Number(m[2])] : null
}

function resolvePython(exec: ProvisionExec, explicit?: string): string {
  for (const c of explicit ? [explicit] : PY_CANDIDATES) {
    const v = pyVersion(exec, c)
    if (v && v[0] === 3 && v[1] >= MIN_MINOR && v[1] <= MAX_MINOR) return c
  }
  throw new CompostError(
    'INVALID_INPUT',
    `no Python 3.${MIN_MINOR}–3.${MAX_MINOR} found (tried ${(explicit ? [explicit] : PY_CANDIDATES).join(', ')}). ` +
      'Install one — e.g. `brew install python@3.11` — or pass --python-bin.',
  )
}

/** Create + populate the managed native venv. Idempotent: a venv that already
 * imports the deps is a no-op unless `force`. */
export function provisionNativeVenv(opts: ProvisionNativeOptions = {}): ProvisionNativeResult {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const exec = opts.exec ?? defaultExec
  const steps: string[] = []

  const transcriberDir =
    opts.transcriberDir ?? env.COMPOST_TRANSCRIBER_DIR ?? findRepoTranscriberDir(undefined, exists)
  if (transcriberDir === undefined || !exists(join(transcriberDir, 'pyproject.toml'))) {
    throw new CompostError(
      'INVALID_INPUT',
      'could not locate the transcriber/ package — it ships inside the npm package since v0.1.2, so an outdated install is the usual cause. Upgrade with `npm install -g @they-juanreina/compost-cli@latest`, or pass --transcriber-dir / set COMPOST_TRANSCRIBER_DIR.',
    )
  }

  const venvDir = managedVenvDir(env)
  const venvPython = join(venvDir, 'bin', 'python')

  if (!opts.force && exists(venvPython) && exec(venvPython, ['-c', VERIFY_IMPORTS]).ok) {
    return {
      status: 'already-ready',
      venvDir,
      venvPython,
      pythonBin: null,
      transcriberDir,
      steps: ['venv present; native deps already import'],
    }
  }

  // Only resolve a host interpreter when we actually need to CREATE the venv;
  // reinstalling deps into an existing venv uses that venv's python, not the host.
  let pythonBin: string | null = null
  if (opts.force || !exists(venvPython)) {
    pythonBin = resolvePython(exec, opts.pythonBin)
    steps.push(`interpreter ${pythonBin}`)
    const mk = exec(pythonBin, ['-m', 'venv', ...(opts.force ? ['--clear'] : []), venvDir])
    if (!mk.ok)
      throw new CompostError('PROVIDER_ERROR', `venv create failed: ${mk.stderr.slice(-300)}`)
    steps.push(`created venv at ${venvDir}`)
  } else {
    steps.push('venv present but deps missing — reinstalling')
  }

  exec(venvPython, ['-m', 'pip', 'install', '-q', '-U', 'pip']) // best-effort
  const install = exec(venvPython, ['-m', 'pip', 'install', ...NATIVE_DEPS], { stream: true })
  if (!install.ok) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `pip install failed: ${install.stderr.slice(-400) || '(see pip output above)'}`,
    )
  }
  steps.push(`installed ${NATIVE_DEPS.length} native deps`)

  const verify = exec(venvPython, ['-c', VERIFY_IMPORTS])
  if (!verify.ok) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native deps did not import after install: ${verify.stderr.slice(-300)}`,
    )
  }
  steps.push('verified parakeet-mlx + pyannote + silero + torchaudio import')

  return { status: 'provisioned', venvDir, venvPython, pythonBin, transcriberDir, steps }
}
