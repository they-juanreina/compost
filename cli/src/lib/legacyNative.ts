import { CompostError } from '../errors.js'
import type { LegacyIngestRequest, LegacyIngestResponse } from '../legacy_client.js'
import { scrubbedEnv } from './childEnv.js'
import { runNativeCli, type SpawnImpl } from './nativeRuntime.js'

export interface NativeLegacyOptions {
  /** Path to a Python (3.11+) interpreter in a venv with the [legacy] deps. */
  python: string
  /** Directory containing the `app` package (the transcriber/ root). */
  transcriberDir: string
  spawnImpl?: SpawnImpl
}

/**
 * Native (host) legacy-ingest path (#184): shell out to `app.legacy_cli` so
 * PDF/DOCX/PPTX/CSV/XLSX/TXT ingest works without the Docker transcriber. Returns
 * the same shape as the `/legacy-ingest` route, so the legacy-worker is agnostic
 * to which path ran. Throws CompostError on spawn failure / non-zero exit.
 */
export function legacyIngestNative(
  req: LegacyIngestRequest,
  opts: NativeLegacyOptions,
): LegacyIngestResponse {
  const args = [
    '-m',
    'app.legacy_cli',
    '--seed-path',
    req.seed_path,
    '--source-path',
    req.source_path,
  ]
  if (req.text_col !== undefined) args.push('--text-col', req.text_col)
  if (req.speaker_col !== undefined) args.push('--speaker-col', req.speaker_col)
  if (req.sheet !== undefined) args.push('--sheet', req.sheet)

  const { parsed, status, stderr } = runNativeCli<
    LegacyIngestResponse & { error?: string; kind?: string }
  >(opts.python, args, {
    cwd: opts.transcriberDir,
    // Legacy document ingest needs no secrets — don't leak tokens to it (#236).
    env: scrubbedEnv(),
    label: 'legacy-ingest',
    startHint: 'Run `compost setup` to provision the native venv, or start the Docker fallback.',
    ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
  })
  if (status !== 0 || parsed.status === 'failed') {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native legacy-ingest failed (${parsed.kind ?? 'error'}): ${parsed.error ?? stderr.slice(-400)}`,
    )
  }
  return parsed
}
