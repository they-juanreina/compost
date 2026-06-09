/**
 * Read-side intelligence (#122): prompt journal, blame lineage, and chat
 * retrieval. All three wrap the CLI engine in-process — blame returns the same
 * chain as `compost blame`, chat reuses the same hybrid retrieval as
 * `compost search` (no LLM call here; the host model synthesizes in #129).
 */
import {
  blame,
  buildDenseRetriever,
  parseVersions,
  readJournal,
  retrieveChunks,
  saveJournal,
} from '@they-juanreina/compost-cli/engine'

import { resolveSeed, seedRoot } from '../actions.js'
import type { AgentsResponse, BlameResponse, ChatResponse, RetrievedChunk } from '../types.js'
import { ApiError } from './http.js'

// ---- prompt journal (AGENTS.md)

export function loadAgents(seed: string): AgentsResponse {
  return parseVersions(readJournal(resolveSeed(seed)))
}

export function saveAgents(
  seed: string,
  draft: string,
  ts: string,
  rerunLoops: boolean,
): { ok: true; mode: 'git' | 'append'; versions: number; rerunRequested: boolean } {
  const result = saveJournal(resolveSeed(seed), draft, ts)
  // rerunLoops is accepted but not acted on here — loops run via the CLI/supervisor.
  return { ok: true, mode: result.mode, versions: result.versions, rerunRequested: rerunLoops }
}

// ---- blame lineage

export function blameForSeed(seed: string, ref: string): BlameResponse {
  resolveSeed(seed) // validate + harden the seed name (NOT_FOUND if missing)
  return blame(ref, { cwd: seedRoot(), seed })
}

// ---- chat retrieval (no LLM)

/**
 * Hybrid retrieval over a seed for the chat panel. Returns citation-shaped
 * chunks; the caller (#129) hands them to the host LLM. Raises NO_INDEX when the
 * seed has nothing to retrieve (no transcribed/ingested sessions) so the UI can
 * prompt `compost reindex` rather than show an empty answer. When sessions exist
 * but no vector index does, it still answers via BM25 (mode: 'bm25').
 */
export async function chatRetrieve(
  seed: string,
  question: string,
  k: number,
): Promise<ChatResponse> {
  const seedPath = resolveSeed(seed)
  const dense = await buildDenseRetriever(seedPath)
  const result = await retrieveChunks(seedPath, question, { topK: k, dense })

  if (result.corpus.chunks.length === 0) {
    throw new ApiError('NO_INDEX', 'No indexed sessions to search in this seed', {
      hint: 'run compost reindex --vectors',
    })
  }

  // Resolve utterance_id for whole-utterance chunks by matching against the
  // corpus evidence map (chunk ids are content hashes, not utterance ids).
  const textToUtterance = new Map<string, string>()
  for (const [uid, ev] of result.corpus.evidence) textToUtterance.set(ev.text, uid)

  const retrieved_chunks: RetrievedChunk[] = result.retrieved.map((c) => ({
    session: c.metadata.session,
    utterance_id: textToUtterance.get(c.text) ?? null,
    quote: c.text,
    score: c.score,
    chunk_type: c.metadata.chunk_type,
  }))

  return { question, retrieved_chunks, k_used: k, mode: result.mode }
}
