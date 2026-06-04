import { resolveFetch } from './llm/http.js'
import type { FetchLike } from './llm/types.js'

export interface TranscribeResponse {
  session_id: string
  transcript_path: string
  status: 'ok' | 'needs_speaker_labels' | 'failed_transcription'
}

export interface TranscriberHealth {
  ok: boolean
  versions: Record<string, string | null>
}

export class TranscriberServiceError extends Error {
  constructor(
    message: string,
    public readonly kind: 'down' | 'model_missing' | 'failed',
  ) {
    super(message)
    this.name = 'TranscriberServiceError'
  }
}

export interface TranscriberClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** HTTP client for the Python transcriber service (compose: localhost:7862). */
export class TranscriberClient {
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(opts: TranscriberClientOptions = {}) {
    this.base = (opts.baseUrl ?? 'http://localhost:7862').replace(/\/$/, '')
    this.fetchImpl = resolveFetch(opts.fetchImpl)
    this.timeoutMs = opts.timeoutMs ?? 1_800_000 // 30 min; transcription is slow
  }

  async health(): Promise<TranscriberHealth> {
    try {
      const res = await this.fetchImpl(`${this.base}/health`, { method: 'GET' })
      if (!res.ok) return { ok: false, versions: {} }
      const json = (await res.json()) as {
        status?: string
        versions?: Record<string, string | null>
      }
      return { ok: json.status === 'ok', versions: json.versions ?? {} }
    } catch {
      return { ok: false, versions: {} }
    }
  }

  /**
   * Invoke POST /transcribe with the body shape the Python route expects.
   *
   * Bug fix (#148): the previous signature sent `{audio_path, session_id}` but
   * the route requires `{seed_path, session_id, source_path}` per its pydantic
   * `TranscribeRequest` model. The route returned 422 on every real call from
   * the worker, breaking `compost transcribe` end-to-end.
   *
   * The fix takes `seedPath` (required) and an optional `language` hint, and
   * sends the body shape the route actually expects. The shape is verified
   * against the contract schema at `cli/contracts/transcribe-request.schema.json`
   * (generated from the pydantic model — see contract test).
   */
  async transcribe(
    audioPath: string,
    sessionId: string,
    seedPath: string,
    language?: string,
  ): Promise<TranscribeResponse> {
    const body: Record<string, unknown> = {
      seed_path: seedPath,
      session_id: sessionId,
      source_path: audioPath,
    }
    if (language !== undefined) body.language = language

    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(`${this.base}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new TranscriberServiceError(
        `transcriber service unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
        'down',
      )
    }
    if (res.status === 503)
      throw new TranscriberServiceError('model missing/unavailable', 'model_missing')
    if (!res.ok) {
      throw new TranscriberServiceError(
        `transcribe failed: ${res.status} ${res.statusText}`,
        'failed',
      )
    }
    return (await res.json()) as TranscribeResponse
  }
}
