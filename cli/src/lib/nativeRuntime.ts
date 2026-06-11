import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CompostError } from '../errors.js'

/**
 * Native (host) transcription runtime resolution (#176, native-first).
 *
 * On Apple Silicon the native path (parakeet-mlx + pyannote on Metal) is ~20×
 * faster than the Docker WhisperX container and runs on real host paths, so it's
 * the default. The Docker container is a documented cross-platform fallback.
 *
 * `compost transcribe` defaults to native when both a Python interpreter and the
 * transcriber package dir resolve; otherwise it falls back to Docker. Resolution
 * precedence: explicit flag > env var > managed venv (provisioned by
 * `compost setup`, #183) / repo-relative package.
 */

export interface NativeRuntimePaths {
  python: string
  transcriberDir: string
}

/** Native Metal/MLX ASR (parakeet-mlx) + pyannote-MPS require Apple Silicon. */
export function isAppleSilicon(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

/** Managed native venv directory, provisioned by `compost setup --provision-native`
 * (#183). `$COMPOST_HOME` overrides the default `~/.compost`. */
export function managedVenvDir(env: NodeJS.ProcessEnv = process.env): string {
  // `?.trim()` so an empty/whitespace COMPOST_HOME doesn't yield a relative path.
  const home = env.COMPOST_HOME?.trim() ? env.COMPOST_HOME : join(homedir(), '.compost')
  return join(home, 'transcriber-venv')
}

/** Managed native venv python (`<venv>/bin/python`). */
export function managedVenvPython(env: NodeJS.ProcessEnv = process.env): string {
  return join(managedVenvDir(env), 'bin', 'python')
}

/** Walk up from this module to find the `transcriber/` package. Works both for
 * repo/dev installs (cli/ and transcriber/ are siblings) and for a published
 * global install, where `prepack` (copy-transcriber.mjs) bundles the source into
 * the cli package so the walk finds `<pkgroot>/transcriber/app/transcribe_cli.py`
 * one level up from dist/ (#206). Returns undefined only when no source is
 * reachable; an explicit `COMPOST_TRANSCRIBER_DIR` overrides this. */
export function findRepoTranscriberDir(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'transcriber')
    if (exists(join(candidate, 'app', 'transcribe_cli.py'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export interface ResolveNativeOpts {
  python?: string
  transcriberDir?: string
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  /** Override repo-dir discovery (tests). */
  repoTranscriberDir?: () => string | undefined
}

/**
 * Resolve the native python + transcriber dir, or null when native isn't
 * available. Precedence: explicit > env > managed venv / repo-relative.
 */
export function resolveNativeRuntime(opts: ResolveNativeOpts = {}): NativeRuntimePaths | null {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const managed = managedVenvPython(env)
  const python =
    opts.python ?? env.COMPOST_TRANSCRIBER_PYTHON ?? (exists(managed) ? managed : undefined)
  const transcriberDir =
    opts.transcriberDir ??
    env.COMPOST_TRANSCRIBER_DIR ??
    (opts.repoTranscriberDir ?? (() => findRepoTranscriberDir(undefined, exists)))()
  if (python === undefined || transcriberDir === undefined) return null
  return { python, transcriberDir }
}

/** Diagnostic view for the doctor (#207): which of the two pieces is
 * missing? `resolveNativeRuntime` returns null when EITHER is missing, which
 * sends users down the wrong remediation when the venv DOES exist but the
 * transcriber source doesn't (e.g. a global npm install). */
export interface NativeRuntimeDiagnosis {
  python?: string
  transcriberDir?: string
  /** Names which inputs would resolve; useful for the "ok with what" path. */
  pythonSource?: 'explicit' | 'env' | 'managed-venv'
  transcriberDirSource?: 'explicit' | 'env' | 'repo-walk'
}

export function diagnoseNativeRuntime(opts: ResolveNativeOpts = {}): NativeRuntimeDiagnosis {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const managed = managedVenvPython(env)

  let python: string | undefined
  let pythonSource: NativeRuntimeDiagnosis['pythonSource']
  if (opts.python !== undefined) {
    python = opts.python
    pythonSource = 'explicit'
  } else if (env.COMPOST_TRANSCRIBER_PYTHON !== undefined) {
    python = env.COMPOST_TRANSCRIBER_PYTHON
    pythonSource = 'env'
  } else if (exists(managed)) {
    python = managed
    pythonSource = 'managed-venv'
  }

  let transcriberDir: string | undefined
  let transcriberDirSource: NativeRuntimeDiagnosis['transcriberDirSource']
  if (opts.transcriberDir !== undefined) {
    transcriberDir = opts.transcriberDir
    transcriberDirSource = 'explicit'
  } else if (env.COMPOST_TRANSCRIBER_DIR !== undefined) {
    transcriberDir = env.COMPOST_TRANSCRIBER_DIR
    transcriberDirSource = 'env'
  } else {
    const walked = (opts.repoTranscriberDir ?? (() => findRepoTranscriberDir(undefined, exists)))()
    if (walked !== undefined) {
      transcriberDir = walked
      transcriberDirSource = 'repo-walk'
    }
  }

  const out: NativeRuntimeDiagnosis = {}
  if (python !== undefined) {
    out.python = python
    if (pythonSource !== undefined) out.pythonSource = pythonSource
  }
  if (transcriberDir !== undefined) {
    out.transcriberDir = transcriberDir
    if (transcriberDirSource !== undefined) out.transcriberDirSource = transcriberDirSource
  }
  return out
}

/**
 * Pick the runtime: an explicit `--runtime` wins; otherwise native on Apple
 * Silicon when resolvable, else Docker (the cross-platform fallback).
 */
export function pickRuntime(
  explicit: string | undefined,
  native: NativeRuntimePaths | null,
  appleSilicon: boolean = isAppleSilicon(),
): 'native' | 'docker' {
  if (explicit === 'native' || explicit === 'docker') return explicit
  return appleSilicon && native !== null ? 'native' : 'docker'
}

/** Injectable spawn surface (real `spawnSync` in prod; a fake in tests). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; maxBuffer: number },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>

export interface RunNativeCliOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Short noun used in the error messages, e.g. 'transcriber' / 'legacy-ingest'. */
  label: string
  /** Recovery hint appended to the failed-to-start message. */
  startHint: string
  spawnImpl?: SpawnImpl
}

export interface NativeCliResult<T> {
  parsed: T
  status: number | null
  stderr: string
}

/**
 * Spawn a native `python -m app.<cli>` entrypoint and parse its single JSON-line
 * result. Owns the spawn dispatch, the 64 MiB buffer, the failed-to-start error,
 * and the last-line/parse/object-guard. The caller keeps its own success check
 * (`status !== 0 || parsed.status === 'failed'`) on the returned
 * `{ parsed, status, stderr }`, since the two callers phrase that failure
 * differently. (#176, #184)
 */
export function runNativeCli<T>(
  python: string,
  args: string[],
  opts: RunNativeCliOptions,
): NativeCliResult<T> {
  const spawn: SpawnImpl = opts.spawnImpl ?? (spawnSync as unknown as SpawnImpl)
  const res = spawn(python, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.error) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native ${opts.label} failed to start (${python}): ${res.error.message}. ${opts.startHint}`,
    )
  }
  const stderr = res.stderr || ''
  // The entrypoint prints exactly one JSON line; take the last non-empty line.
  const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: T
  try {
    // JSON.parse succeeds on primitives (null, 123, "s"); require an object so a
    // stray non-object line surfaces as the CompostError below, not a TypeError.
    const value: unknown = JSON.parse(lastLine)
    if (typeof value !== 'object' || value === null) throw new Error('not a JSON object')
    parsed = value as T
  } catch {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native ${opts.label} produced no parseable result. stderr: ${stderr.slice(-400)}`,
    )
  }
  return { parsed, status: res.status, stderr }
}
