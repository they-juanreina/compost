import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  BM25Index,
  type Chunk,
  type ChunkerTranscript,
  chunkTranscript,
  type DenseRetriever,
  dedupeByRegion,
  type EvidenceSet,
  HybridRetriever,
  openLanceDBForRead,
  type ScoredChunk,
} from '@they-juanreina/compost-retrieval'

import { LLMAdapter } from '../llm/adapter.js'
import { type CompostConfig, loadConfig } from './config.js'
import { seedNameOf } from './seedResolve.js'

/**
 * Shared retrieval primitives for `compost search` (retrieval-only) and
 * `compost chat` (retrieval + LLM synthesis). Extracted so the two commands
 * never diverge on how the corpus is loaded, chunked, and ranked.
 *
 * Retrieval is hybrid: when a LanceDB index and an embeddings provider are
 * both present, BM25 ∪ dense results are fused via RRF (HybridRetriever's dense
 * slot is filled by buildDenseRetriever, which reads the index the embed-worker
 * writes). When either is missing it falls back to BM25-only. `search` and
 * `chat` share this path, so both rank the same way.
 */

export interface LoadedCorpus {
  chunks: Chunk[]
  evidence: EvidenceSet
  seedName: string
}

/**
 * Load every session transcript under a seed into:
 *   - `chunks`: chunked text for retrieval (utterance + neighbor windows + …)
 *   - `evidence`: utterance_id → {session_id, text}, for citation validation
 */
export function loadSeedCorpus(seedPath: string): LoadedCorpus {
  const seedName = seedNameOf(seedPath)
  const sessionsDir = join(seedPath, 'sessions')
  const evidence: EvidenceSet = new Map()
  const allChunks: Chunk[] = []
  if (!existsSync(sessionsDir)) return { chunks: [], evidence, seedName }

  for (const entry of readdirSync(sessionsDir)) {
    if (entry.startsWith('.') || entry === '_inbox') continue
    const tPath = join(sessionsDir, entry, 'transcript.json')
    if (!existsSync(tPath) || !statSync(tPath).isFile()) continue
    const transcript = JSON.parse(readFileSync(tPath, 'utf8')) as ChunkerTranscript & {
      utterances: Array<{ id: string; text: string }>
    }
    for (const u of transcript.utterances) {
      evidence.set(u.id, { session_id: transcript.session_id, text: u.text })
    }
    allChunks.push(...chunkTranscript(transcript, { seed: seedName }))
  }
  return { chunks: allChunks, evidence, seedName }
}

export type RetrievalMode = 'hybrid' | 'bm25'

export interface RetrieveOptions {
  topK?: number
  /** Dense retriever (LanceDB). When provided, retrieval is BM25 ∪ dense fused
   * via RRF. When null/omitted, BM25-only. Inject via buildDenseRetriever. */
  dense?: DenseRetriever | null
  /** Collapse near-duplicate chunks covering the same region before the topK cut
   * (#170). Default true; set false for the raw fused ranking. */
  dedupe?: boolean
}

export interface RetrieveResult {
  retrieved: ScoredChunk[]
  corpus: LoadedCorpus
  mode: RetrievalMode
}

/**
 * Rank corpus chunks against a query. Returns ScoredChunks (highest first).
 * Empty array when the seed has no indexed sessions or nothing matches.
 *
 * Hybrid (BM25 + dense via RRF) when a dense retriever is supplied; BM25-only
 * otherwise. The `mode` field reports which ran.
 */
export async function retrieveChunks(
  seedPath: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const corpus = loadSeedCorpus(seedPath)
  const dense = opts.dense ?? null
  const mode: RetrievalMode = dense ? 'hybrid' : 'bm25'
  if (corpus.chunks.length === 0) return { retrieved: [], corpus, mode }

  const topK = opts.topK ?? 8
  const bm25 = new BM25Index()
  bm25.addAll(corpus.chunks)
  const retriever = new HybridRetriever(bm25, dense)

  if (opts.dedupe === false) {
    const retrieved = await retriever.retrieve(query, { topK })
    return { retrieved, corpus, mode }
  }
  // Over-fetch a pool, collapse same-region near-duplicates (#170), then cut to
  // topK — so top-k holds topK *distinct* regions, not the same phrase repeated
  // as a solo utterance + several overlapping windows.
  const pool = Math.max(topK * 5, 50)
  const fused = await retriever.retrieve(query, { topK: pool })
  const retrieved = dedupeByRegion(fused).slice(0, topK)
  return { retrieved, corpus, mode }
}

/**
 * Build a dense retriever for a seed, or return null when dense isn't available
 * — no LanceDB index yet, the native binary absent, or the embeddings provider
 * unreachable. Never throws: a null result means the caller does BM25-only, so
 * `compost search` always works even with Ollama down.
 */
export async function buildDenseRetriever(
  seedPath: string,
  config?: CompostConfig,
): Promise<DenseRetriever | null> {
  const uri = join(seedPath, '.compost', 'vectors.lancedb')
  if (!existsSync(uri)) return null

  let adapter: LLMAdapter
  try {
    adapter = new LLMAdapter(config ?? loadConfig(seedPath))
  } catch {
    return null
  }

  const embedQuery = async (q: string): Promise<number[]> => {
    const resp = await adapter.embed('embeddings', [q])
    const vec = resp.vectors[0]
    if (vec === undefined) throw new Error('embeddings provider returned no vector')
    return vec
  }

  // openLanceDBForRead is null-safe (missing index / absent binary); we still
  // wrap in try/catch so a provider/config error degrades to BM25, not a throw.
  try {
    return await openLanceDBForRead(uri, embedQuery)
  } catch {
    return null
  }
}
