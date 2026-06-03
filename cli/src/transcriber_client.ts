import type { FetchLike } from './llm/types.js'
import { resolveFetch } from './llm/http.js'

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
      const json = (await res.json()) as { status?: string; versions?: Record<string, string | null> }
      return { ok: json.status === 'ok', versions: json.versions ?? {} }
    } catch {
      return { ok: false, versions: {} }
    }
  }

  async transcribe(audioPath: string, sessionId: string): Promise<TranscribeResponse> {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await this.fetchImpl(`${this.base}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio_path: audioPath, session_id: sessionId }),
      })
    } catch (err) {
      throw new TranscriberServiceError(
        `transcriber service unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
        'down',
      )
    }
    if (res.status === 503) throw new TranscriberServiceError('model missing/unavailable', 'model_missing')
    if (!res.ok) {
      throw new TranscriberServiceError(`transcribe failed: ${res.status} ${res.statusText}`, 'failed')
    }
    return (await res.json()) as TranscribeResponse
  }
}
