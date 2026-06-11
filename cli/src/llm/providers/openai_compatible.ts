import { failedHealth, getJsonTimed, postJson, resolveFetch } from '../http.js'
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
 * Shared driver for OpenAI-compatible HTTP APIs. LM Studio and OpenAI both
 * speak this dialect; they differ only in name, default base URL, and auth.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string
  private readonly base: string
  private readonly apiKey: string | undefined
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(name: string, config: ProviderConfig) {
    this.name = name
    this.base = config.baseUrl.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.fetchImpl = resolveFetch(config.fetchImpl)
    this.timeoutMs = config.timeoutMs ?? 120000
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    if (req.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'compost_schema', schema: req.schema, strict: true },
      }
    }
    const json = (await postJson(
      this.fetchImpl,
      `${this.base}/chat/completions`,
      body,
      this.authHeaders(),
      this.timeoutMs,
    )) as { choices?: Array<{ message?: { content?: string } }> }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: req.model,
      provider: this.name,
      raw: json,
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const json = (await postJson(
      this.fetchImpl,
      `${this.base}/embeddings`,
      { model: req.model, input: req.input },
      this.authHeaders(),
      this.timeoutMs,
    )) as { data?: Array<{ embedding: number[] }> }
    return {
      vectors: (json.data ?? []).map((d) => d.embedding),
      model: req.model,
      provider: this.name,
    }
  }

  async health(): Promise<ProviderHealth> {
    try {
      const { json, latency_ms } = await getJsonTimed(
        this.fetchImpl,
        `${this.base}/models`,
        this.authHeaders(),
      )
      const data = (json as { data?: Array<{ id: string }> }).data ?? []
      return { ok: true, latency_ms, model_list: data.map((m) => m.id) }
    } catch (err) {
      return failedHealth(err)
    }
  }
}
