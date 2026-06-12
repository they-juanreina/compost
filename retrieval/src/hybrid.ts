import type { BM25Index } from './bm25.js'
import { RRF_K, reciprocalRankFusion } from './rrf.js'
import type { Chunk, ChunkMetadata, ScoredChunk } from './types.js'

export interface RetrievalFilters {
  seed?: string
  session?: string
  speaker_id?: string[]
  actor_type?: ChunkMetadata['actor_type'][]
  /** Restrict to sourced documents by author (#270). A chunk matches if its
   * attribution.author is one of these. */
  author?: string[]
  /** Restrict to one codebook frame (#275): a chunk matches if its
   * codebook_ids set contains this CB- id. */
  codebook_id?: string
  /** Restrict to chunks covering any of these codes (#275). */
  code_ids?: string[]
}

/** A dense retriever (vectors) — implemented by the LanceDB/BGE path (#43,#44).
 * Hybrid takes it as a dependency so the fusion logic is testable in isolation. */
export interface DenseRetriever {
  search(query: string, k: number): Promise<ScoredChunk[]> | ScoredChunk[]
}

export interface HybridOptions {
  rrfK?: number
  topK?: number
  filters?: RetrievalFilters
}

function matchesFilters(c: Chunk, f?: RetrievalFilters): boolean {
  if (f === undefined) return true
  if (f.seed !== undefined && c.metadata.seed !== f.seed) return false
  if (f.session !== undefined && c.metadata.session !== f.session) return false
  if (
    f.speaker_id !== undefined &&
    !(c.metadata.speaker_id !== null && f.speaker_id.includes(c.metadata.speaker_id))
  )
    return false
  if (f.actor_type !== undefined && !f.actor_type.includes(c.metadata.actor_type)) return false
  if (f.author !== undefined) {
    const author = c.metadata.attribution?.author
    if (author === undefined || !f.author.includes(author)) return false
  }
  if (f.codebook_id !== undefined && !(c.metadata.codebook_ids ?? []).includes(f.codebook_id)) {
    return false
  }
  if (f.code_ids !== undefined) {
    const have = new Set(c.metadata.code_ids)
    if (!f.code_ids.some((id) => have.has(id))) return false
  }
  return true
}

export class HybridRetriever {
  constructor(
    private readonly bm25: BM25Index,
    private readonly dense: DenseRetriever | null = null,
  ) {}

  /** Single entry point: BM25 ∪ dense, fused via RRF, metadata-filtered. */
  async retrieve(query: string, opts: HybridOptions = {}): Promise<ScoredChunk[]> {
    const topK = opts.topK ?? 50
    const k = opts.rrfK ?? RRF_K
    // Over-fetch before filtering so filters don't starve the top-K.
    const pool = topK * 4
    const lexical = this.bm25.search(query, pool)
    const lists: ScoredChunk[][] = [lexical]
    if (this.dense !== null) {
      lists.push(await this.dense.search(query, pool))
    }
    const fused = reciprocalRankFusion(lists, k, Number.POSITIVE_INFINITY as unknown as number)
    return fused.filter((c) => matchesFilters(c, opts.filters)).slice(0, topK)
  }
}
