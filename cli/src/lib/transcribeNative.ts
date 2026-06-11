import { CompostError } from '../errors.js'
import { childEnv } from './childEnv.js'
import { runNativeCli, type SpawnImpl } from './nativeRuntime.js'

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
  /** Extra env (e.g. HUGGINGFACE_TOKEN for pyannote). Layered over a *scrubbed*
   * process.env — the child gets PATH/locale/etc. and only the secrets passed
   * here, never the parent's other tokens (LLM API keys). */
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

  const { parsed, status, stderr } = runNativeCli<NativeTranscribeResult>(opts.python, args, {
    cwd: opts.transcriberDir,
    // Scrub LLM/other secrets from the inherited env; re-add only what the
    // caller passed (the HF token for pyannote) — least privilege (#236).
    env: childEnv(opts.env),
    label: 'transcriber',
    startHint: 'Run `compost setup` to provision the native transcription venv.',
    ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
  })
  if (status !== 0 || parsed.status === 'failed') {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native transcription failed: ${parsed.error ?? stderr.slice(-400)}`,
    )
  }
  return parsed
}
