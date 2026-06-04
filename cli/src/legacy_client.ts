import { resolveFetch } from './llm/http.js'
import type { FetchLike } from './llm/types.js'

export interface LegacyIngestRequest {
  seed_path: string
  source_path: string
  text_col?: string
  speaker_col?: string
  sheet?: string
}

export interface LegacyIngestResponse {
  source_path: string
  normalized_path: string
  utterance_count: number
  status: 'ok' | 'empty' | 'failed'
  /** Which CSV/XLSX column was actually used (may differ from the request when
   * the server auto-detected it). null for non-tabular inputs. */
  text_col_resolved?: string | null
}

export class LegacyServiceError extends Error {
  constructor(
    message: string,
    public readonly kind: 'down' | 'dep_missing' | 'invalid_input' | 'failed',
  ) {
    super(message)
    this.name = 'LegacyServiceError'
  }
}

export interface LegacyClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** HTTP client for the transcriber service's /legacy-ingest route. */
export class LegacyIngestClient {
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(opts: LegacyClientOptions = {}) {
    this.base = (opts.baseUrl ?? 'http://localhost:7862').replace(/\/$/, '')
    this.fetchImpl = resolveFetch(opts.fetchImpl)
    this.timeoutMs = opts.timeoutMs ?? 600_000 // 10 min; PDFs with OCR can be slow
  }

  async ingest(req: LegacyIngestRequest): Promise<LegacyIngestResponse> {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(`${this.base}/legacy-ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
    } catch (err) {
      throw new LegacyServiceError(
        `legacy-ingest service unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
        'down',
      )
    }
    if (res.status === 503)
      throw new LegacyServiceError(
        'legacy-ingest dep missing (install transcriber [legacy] extras)',
        'dep_missing',
      )
    if (res.status === 422) {
      const body = (await res.json()) as { detail?: string }
      throw new LegacyServiceError(`invalid_input: ${body.detail ?? 'unknown'}`, 'invalid_input')
    }
    if (!res.ok) {
      throw new LegacyServiceError(
        `legacy-ingest failed: ${res.status} ${res.statusText}`,
        'failed',
      )
    }
    return (await res.json()) as LegacyIngestResponse
  }
}
