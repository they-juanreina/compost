import { createHash } from 'node:crypto'

export const DEFAULT_BATCH_SIZE = 32
export const DEFAULT_EMBED_MODEL = 'bge-m3:q4_k_m'

/** Provider-agnostic embed function (e.g. the LLM adapter's Ollama embed). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** Persistent cache keyed by content SHA — survives Ollama restarts. The CLI
 * backs this with SQLite; tests use an in-memory Map. */
export interface EmbeddingCache {
  get(sha: string): number[] | undefined
  set(sha: string, vector: number[]): void
}

export class MemoryCache implements EmbeddingCache {
  private readonly m = new Map<string, number[]>()
  get(sha: string) {
    return this.m.get(sha)
  }
  set(sha: string, v: number[]) {
    this.m.set(sha, v)
  }
}

export function textSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface EmbedderOptions {
  model?: string
  batchSize?: number
  cache?: EmbeddingCache
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

export interface EmbedResult {
  vectors: number[][]
  model: string
  cache_hits: number
  computed: number
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class Embedder {
  readonly model: string
  private readonly batchSize: number
  private readonly cache: EmbeddingCache
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly embedFn: EmbedFn,
    opts: EmbedderOptions = {},
  ) {
    this.model = opts.model ?? DEFAULT_EMBED_MODEL
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
    this.cache = opts.cache ?? new MemoryCache()
    this.maxRetries = opts.maxRetries ?? 3
    this.sleep = opts.sleep ?? realSleep
  }

  /** Embed texts, serving cache hits by SHA and batching the misses. Retries a
   * failed batch with exponential backoff (Ollama restart tolerance). */
  async embed(texts: string[]): Promise<EmbedResult> {
    const shas = texts.map(textSha)
    const vectors = new Array<number[] | undefined>(texts.length)
    const missIdx: number[] = []
    let cacheHits = 0

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(shas[i]!)
      if (cached !== undefined) {
        vectors[i] = cached
        cacheHits += 1
      } else {
        missIdx.push(i)
      }
    }

    for (let b = 0; b < missIdx.length; b += this.batchSize) {
      const batchIdx = missIdx.slice(b, b + this.batchSize)
      const batchTexts = batchIdx.map((i) => texts[i]!)
      const batchVecs = await this.embedWithRetry(batchTexts)
      batchIdx.forEach((i, j) => {
        const v = batchVecs[j]!
        vectors[i] = v
        this.cache.set(shas[i]!, v)
      })
    }

    return {
      vectors: vectors.map((v) => v ?? []),
      model: this.model,
      cache_hits: cacheHits,
      computed: missIdx.length,
    }
  }

  private async embedWithRetry(texts: string[]): Promise<number[][]> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.embedFn(texts)
      } catch (err) {
        lastErr = err
        if (attempt < this.maxRetries) await this.sleep(250 * 2 ** attempt)
      }
    }
    throw new Error(`embedding failed after ${this.maxRetries} retries: ${String(lastErr)}`)
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
