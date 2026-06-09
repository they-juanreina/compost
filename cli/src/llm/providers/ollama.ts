import { CompostError } from '../../errors.js'
import { getJsonTimed, postJson, resolveFetch } from '../http.js'
import type {
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
  FetchLike,
  Provider,
  ProviderConfig,
  ProviderHealth,
} from '../types.js'

/**
 * Ollama returns 404 with body `{"error":"model 'X' not found"}` when the
 * requested model hasn't been pulled. postJson surfaces that as a raw
 * "POST … → 404 Not Found: …" Error — unactionable. Translate it to a
 * CompostError that names the `ollama pull` to run (#191). Parallels the
 * #160 fix that gave the missing-cloud-key case the same treatment.
 *
 * Returns the original error untouched when the pattern doesn't match, so
 * non-404 failures (provider_down, timeouts, schema errors) keep flowing.
 */
function translateOllamaError(err: unknown, model: string): Error {
  if (!(err instanceof Error)) return new Error(String(err))
  // A timed-out request surfaces as a bare AbortError ("This operation was
  // aborted") — unactionable. Big local models routinely need >120s just to
  // load into memory on first use, so name the model and the two ways out.
  if (err.name === 'AbortError' || /operation was aborted/i.test(err.message)) {
    return new CompostError(
      'PROVIDER_ERROR',
      `Ollama model '${model}' did not answer within the timeout — large models can take minutes to load on first use. Route the task to a smaller model (\`compost setup\` configures one), or raise providers.ollama.timeout_ms in config.toml.`,
      { cause: err },
    )
  }
  // postJson formats: `POST <url> → <status> <statusText>: <bodyPrefix>`
  if (!/→ 404 /.test(err.message)) return err
  if (!/model .* not found/i.test(err.message)) return err
  return new CompostError(
    'PROVIDER_ERROR',
    `Ollama model '${model}' not found — run \`ollama pull ${model}\` (or set the relevant defaults.* in compost.config.yaml to a pulled model).`,
    { cause: err },
  )
}

export class OllamaProvider implements Provider {
  readonly name = 'ollama'
  private readonly base: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(config: ProviderConfig) {
    this.base = config.baseUrl.replace(/\/$/, '')
    this.fetchImpl = resolveFetch(config.fetchImpl)
    this.timeoutMs = config.timeoutMs ?? 120000
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
    }
    if (req.schema) body.format = req.schema
    if (req.temperature !== undefined) body.options = { temperature: req.temperature }
    let json: { message?: { content?: string } }
    try {
      json = (await postJson(
        this.fetchImpl,
        `${this.base}/api/chat`,
        body,
        {},
        this.timeoutMs,
      )) as { message?: { content?: string } }
    } catch (err) {
      throw translateOllamaError(err, req.model)
    }
    return {
      text: json.message?.content ?? '',
      model: req.model,
      provider: this.name,
      raw: json,
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    let json: { embeddings?: number[][] }
    try {
      json = (await postJson(
        this.fetchImpl,
        `${this.base}/api/embed`,
        { model: req.model, input: req.input },
        {},
        this.timeoutMs,
      )) as { embeddings?: number[][] }
    } catch (err) {
      throw translateOllamaError(err, req.model)
    }
    return {
      vectors: json.embeddings ?? [],
      model: req.model,
      provider: this.name,
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      const { json, latency_ms } = await getJsonTimed(this.fetchImpl, `${this.base}/api/tags`)
      const models = (json as { models?: Array<{ name: string }> }).models ?? []
      return { ok: true, latency_ms, model_list: models.map((m) => m.name) }
    } catch (err) {
      return {
        ok: false,
        latency_ms: 0,
        model_list: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
