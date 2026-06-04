import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  BM25Index,
  type Chunk,
  type ChunkerTranscript,
  chunkTranscript,
  type DenseRetriever,
  type EvidenceSet,
  HybridRetriever,
  openLanceDBForRead,
  type ScoredChunk,
} from 'compost-retrieval'

import { LLMAdapter } from '../llm/adapter.js'
import { type CompostConfig, loadConfig } from './config.js'

/**
 * Shared retrieval primitives for `compost search` (retrieval-only) and
 * `compost chat` (retrieval + LLM synthesis). Extracted so the two commands
 * never diverge on how the corpus is loaded, chunked, and ranked.
 *
 * Retrieval is BM25-only today: HybridRetriever's dense slot is null because
 * nothing reads the LanceDB index the embed-worker writes (#137). Wiring
 * LanceDBRetriever into this shared path is a follow-up that upgrades both
 * `search` and `chat` ranking at once — see the tracking issue.
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
  const seedName = seedPath.split('/').pop() ?? 'seed'
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

  const bm25 = new BM25Index()
  bm25.addAll(corpus.chunks)
  const retriever = new HybridRetriever(bm25, dense)
  const retrieved = await retriever.retrieve(query, { topK: opts.topK ?? 8 })
  return { retrieved, corpus, mode }
}

/** Embedding-vector dimension by model tag (mirrors the embed-worker's table). */
const DIM_BY_MODEL: Record<string, number> = {
  'bge-m3': 1024,
  'bge-m3:q4_k_m': 1024,
  'mxbai-embed-large': 1024,
  'nomic-embed-text': 768,
  'all-minilm': 384,
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
