import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { CompostError } from '../errors.js'
import type { LegacyIngestRequest, LegacyIngestResponse } from '../legacy_client.js'

/** Injectable spawn surface (real `spawnSync` in prod; a fake in tests). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; maxBuffer: number },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>

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

  const spawn: SpawnImpl = opts.spawnImpl ?? (spawnSync as unknown as SpawnImpl)
  const res = spawn(opts.python, args, {
    cwd: opts.transcriberDir,
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (res.error) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native legacy-ingest failed to start (${opts.python}): ${res.error.message}. ` +
        'Run `compost setup` to provision the native venv, or start the Docker fallback.',
    )
  }
  const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed: LegacyIngestResponse & { error?: string; kind?: string }
  try {
    const value: unknown = JSON.parse(lastLine)
    if (typeof value !== 'object' || value === null) throw new Error('not a JSON object')
    parsed = value as LegacyIngestResponse & { error?: string; kind?: string }
  } catch {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native legacy-ingest produced no parseable result. stderr: ${(res.stderr || '').slice(-400)}`,
    )
  }
  if (res.status !== 0 || parsed.status === 'failed') {
    throw new CompostError(
      'PROVIDER_ERROR',
      `native legacy-ingest failed (${parsed.kind ?? 'error'}): ${parsed.error ?? (res.stderr || '').slice(-400)}`,
    )
  }
  return parsed
}
