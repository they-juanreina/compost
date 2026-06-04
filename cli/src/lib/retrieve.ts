import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  BM25Index,
  type Chunk,
  type ChunkerTranscript,
  chunkTranscript,
  type EvidenceSet,
  HybridRetriever,
  type ScoredChunk,
} from 'compost-retrieval'

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

export interface RetrieveOptions {
  topK?: number
}

/**
 * Rank corpus chunks against a query. Returns ScoredChunks (highest first).
 * Empty array when the seed has no indexed sessions or nothing matches.
 */
export async function retrieveChunks(
  seedPath: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<{ retrieved: ScoredChunk[]; corpus: LoadedCorpus }> {
  const corpus = loadSeedCorpus(seedPath)
  if (corpus.chunks.length === 0) return { retrieved: [], corpus }

  const bm25 = new BM25Index()
  bm25.addAll(corpus.chunks)
  // Dense slot intentionally null until LanceDBRetriever is wired (follow-up).
  const retriever = new HybridRetriever(bm25)
  const retrieved = await retriever.retrieve(query, { topK: opts.topK ?? 8 })
  return { retrieved, corpus }
}
