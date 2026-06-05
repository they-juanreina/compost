import { type SpawnSyncReturns, spawnSync } from 'node:child_process'

import { CompostError } from '../errors.js'

/** Injectable spawn surface (real `spawnSync` in prod; a fake in tests). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; maxBuffer: number },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>

/**
 * Native (host) transcription path (#176): shell out to the transcriber
 * package's `app.transcribe_cli` running in a host Python venv, so Apple-Silicon
 * ASR (`parakeet-mlx` / Metal) and pyannote use the GPU/CPU directly instead of
 * the CPU-only Docker container. The Python entrypoint shares the exact same
 * `run_pipeline` orchestration as the Docker `/transcribe` route.
 */

export interface NativeTranscribeOptions {
  /** Path to a Python (3.11+) interpreter in a venv with the native deps. */
  python: string
  /** Directory containing the `app` package (the transcriber/ root). */
  transcriberDir: string
  /** ASR engine: 'parakeet' (default, native Metal) or 'whisper'. */
  engine: string
  /** Optional ASR model id (engine default when omitted). */
  model?: string
  /** Optional language hint (recorded; Parakeet v3 auto-detects). */
  language?: string
  /** Extra env (e.g. HUGGINGFACE_TOKEN for pyannote). Merged over process.env. */
  env?: NodeJS.ProcessEnv
  /** Injectable spawn (tests). Defaults to node:child_process spawnSync. */
  spawnImpl?: SpawnImpl
}

export interface NativeTranscribeResult {
  session_id: string
  transcript_path: string
  status: string
  engine?: string
  model?: string
  error?: string
}

/** Run the native transcriber entrypoint synchronously and return its parsed
 * JSON result. Throws a CompostError on spawn failure, non-zero exit, or a
 * `status: "failed"` payload. */
export function transcribeNative(
  seedPath: string,
  sessionId: string,
  sourcePath: string,
  opts: NativeTranscribeOptions,
): NativeTranscribeResult {
  const args = [
    '-m',
    'app.transcribe_cli',
    '--seed-path',
    seedPath,
    '--session-id',
    sessionId,
    '--source-path',
    sourcePath,
    '--engine',
    opts.engine,
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.language) args.push('--language', opts.language)

  const spawn: SpawnImpl = opts.spawnImpl ?? (spawnSync as unknown as SpawnImpl)
  const res = spawn(opts.python, args, {
    cwd: opts.transcriberDir,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (res.error) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native transcriber failed to start (${opts.python}): ${res.error.message}. ` +
        'Run `compost setup` to provision the native transcription venv.',
    )
  }
  // The entrypoint prints exactly one JSON line; take the last non-empty line.
  const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: NativeTranscribeResult
  try {
    parsed = JSON.parse(lastLine) as NativeTranscribeResult
  } catch {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native transcriber produced no parseable result. stderr: ${(res.stderr || '').slice(-400)}`,
    )
  }
  if (res.status !== 0 || parsed.status === 'failed') {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native transcription failed: ${parsed.error ?? (res.stderr || '').slice(-400)}`,
    )
  }
  return parsed
}
