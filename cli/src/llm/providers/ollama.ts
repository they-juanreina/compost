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
    const json = (await postJson(
      this.fetchImpl,
      `${this.base}/api/chat`,
      body,
      {},
      this.timeoutMs,
    )) as { message?: { content?: string } }
    return {
      text: json.message?.content ?? '',
      model: req.model,
      provider: this.name,
      raw: json,
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const json = (await postJson(
      this.fetchImpl,
      `${this.base}/api/embed`,
      { model: req.model, input: req.input },
      {},
      this.timeoutMs,
    )) as { embeddings?: number[][] }
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
