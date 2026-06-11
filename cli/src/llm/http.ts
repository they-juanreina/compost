import { errMessage } from '../errors.js'
import { redactSecrets } from '../lib/redact.js'
import type { FetchLike, ProviderHealth } from './types.js'

/** A non-OK HTTP response. Carries the status so callers can branch (e.g. map
 * 401/403 → an auth error) without parsing the message. The message keeps the
 * existing `<METHOD> <url> → <status> <statusText>: <body>` format that other
 * code (Ollama 404 translation) still matches on. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** The canonical `health()` failure value: a down provider with the reason.
 * Every provider's catch block (and the adapter's per-provider guard) returns
 * this, so the shape stays identical in one place. */
export function failedHealth(err: unknown): ProviderHealth {
  return { ok: false, latency_ms: 0, model_list: [], error: errMessage(err) }
}

export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected
  // Node 18+ has global fetch. Cast through the structural FetchLike.
  return globalThis.fetch as unknown as FetchLike
}

export interface TimedJson {
  json: unknown
  latency_ms: number
}

/** A monotonic-ish clock that does not use Date.now directly in hot paths. */
function nowMs(): number {
  return performance.now()
}

export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 120000,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await safeText(res)
      throw new HttpError(
        `POST ${url} → ${res.status} ${res.statusText}: ${detail}`,
        res.status,
        url,
      )
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function getJsonTimed(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 10000,
): Promise<TimedJson> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = nowMs()
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const latency_ms = Math.round(nowMs() - start)
    if (!res.ok) {
      const detail = await safeText(res)
      throw new HttpError(
        `GET ${url} → ${res.status} ${res.statusText}: ${detail}`,
        res.status,
        url,
      )
    }
    return { json: await res.json(), latency_ms }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    // Redact: a hostile/self-hosted OpenAI-compatible endpoint could echo the
    // submitted Authorization header back in its JSON error body (#236).
    return redactSecrets((await res.text()).slice(0, 200))
  } catch {
    return '<no body>'
  }
}
