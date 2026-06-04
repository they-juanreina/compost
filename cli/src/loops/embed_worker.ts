import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Chunk, ChunkerTranscript, IndexableArtifact, LanceDBWriter } from 'compost-retrieval'
import { buildVectorRecords, chunkTranscript, openLanceDBForWrite } from 'compost-retrieval'

import { CompostError } from '../errors.js'
import { loadConfig, parseRoute } from '../lib/config.js'
import { LLMAdapter } from '../llm/adapter.js'

/**
 * Embed-worker: discovers chunkable artifacts under a seed, embeds new ones
 * via the configured embeddings provider (Ollama by default), and writes them
 * to LanceDB. Idempotent on `text_sha`: re-running over the same content
 * inserts zero new rows.
 *
 * Triggers in v0.1: every `transcript.json` under `sessions/`. Highlights /
 * codes / themes get bonus chunks via the chunker's transcript-aware mode,
 * so a transcript ingest produces all needed indexable artifacts.
 *
 * Glossary terms and legacy chunks land here in follow-ups (v0.1-02 legacy
 * route; glossary embedding is part of #137 itself but plumbing the
 * highlight/code/theme chunks per individual artifact write needs the
 * MCP tool layer from v0.1-05). For v0.1, this single transcript-pass is
 * sufficient because it produces utterance + window chunks that ground the
 * chat surface.
 */

export interface EmbedWorkerDeps {
  /** Override the LanceDB writer (injected in tests). */
  writer?: LanceDBWriter
  /** Override the embeddings call (injected in tests). */
  embed?: (texts: string[]) => Promise<number[][]>
  /** Override the embedding dimension (must match what the writer expects). */
  vectorDim?: number
}

export interface EmbedWorkerResult {
  embedded: number
  inserted: number
  transcripts_scanned: number
}

export async function runEmbedWorkerOnce(
  seedPath: string,
  deps: EmbedWorkerDeps = {},
): Promise<EmbedWorkerResult> {
  const seedName = seedPath.split('/').pop() ?? 'seed'
  const transcripts = findTranscripts(seedPath)
  if (transcripts.length === 0) {
    return { embedded: 0, inserted: 0, transcripts_scanned: 0 }
  }

  // Resolve embeddings provider + dimension.
  let embed = deps.embed
  let vectorDim = deps.vectorDim ?? 1024
  if (embed === undefined) {
    const config = loadConfig(seedPath)
    const adapter = new LLMAdapter(config)
    embed = async (texts: string[]) => {
      const resp = await adapter.embed('embeddings', texts)
      return resp.vectors
    }
    // Try to discover dim from the provider config — most embeddings models
    // declare it in their tag. bge-m3 is 1024; mxbai-embed-large is 1024 too.
    // Fall back to 1024 by default; mismatches surface as a clear LanceDB error.
    const route = config.defaults.embeddings
    if (route !== undefined) {
      const { model } = parseRoute(route)
      vectorDim = DEFAULT_DIM_FOR_MODEL[model] ?? 1024
    }
  }

  // Chunk every transcript.
  const allChunks: Array<Chunk & { sessionId: string }> = []
  for (const t of transcripts) {
    const transcript = JSON.parse(readFileSync(t.path, 'utf8')) as ChunkerTranscript
    const chunks = chunkTranscript(transcript, { seed: seedName })
    for (const c of chunks) allChunks.push({ ...c, sessionId: t.sessionId })
  }

  if (allChunks.length === 0) {
    return { embedded: 0, inserted: 0, transcripts_scanned: transcripts.length }
  }

  // Open / create the LanceDB table, then filter for new SHAs before embedding
  // (avoid wasting embed calls on content we'd dedup away anyway).
  const writer =
    deps.writer ??
    (await openLanceDBForWrite(join(seedPath, '.compost', 'vectors.lancedb'), vectorDim))

  // Embed in one batch (the LLM adapter handles internal batching).
  const vectors = await embed(allChunks.map((c) => c.text))
  if (vectors.length !== allChunks.length) {
    throw new CompostError(
      'PROVIDER_ERROR',
      `embeddings provider returned ${vectors.length} vectors for ${allChunks.length} chunks`,
    )
  }

  // Build LanceDB rows.
  const records = buildVectorRecords(
    allChunks.map(
      (c, i): IndexableArtifact => ({
        id: c.id,
        kind: chunkTypeToArtifactKind(c.metadata.chunk_type),
        seed: seedName,
        session: c.sessionId,
        speaker_id: c.metadata.speaker_id,
        start_ms: c.metadata.start_ms,
        end_ms: c.metadata.end_ms,
        text: c.text,
        text_sha: c.text_sha,
        vector: vectors[i] as number[],
        metadata: {
          source_page: c.metadata.source_page,
          highlight_ids: c.metadata.highlight_ids,
          code_ids: c.metadata.code_ids,
          actor_type: c.metadata.actor_type,
          chunk_type: c.metadata.chunk_type,
        },
      }),
    ),
  )

  const inserted = await writer.upsertByTextSha(records)
  return {
    embedded: allChunks.length,
    inserted,
    transcripts_scanned: transcripts.length,
  }
}

const DEFAULT_DIM_FOR_MODEL: Record<string, number> = {
  'bge-m3': 1024,
  'bge-m3:q4_k_m': 1024,
  'mxbai-embed-large': 1024,
  'nomic-embed-text': 768,
  'all-minilm': 384,
}

function chunkTypeToArtifactKind(
  type: 'utterance' | 'window' | 'highlight' | 'term' | 'page',
): IndexableArtifact['kind'] {
  switch (type) {
    case 'highlight':
      return 'highlight'
    case 'term':
      return 'term'
    case 'page':
      return 'legacy_chunk'
    default:
      return 'utterance'
  }
}

interface TranscriptHandle {
  sessionId: string
  path: string
}

function findTranscripts(seedPath: string): TranscriptHandle[] {
  const sessionsDir = join(seedPath, 'sessions')
  if (!existsSync(sessionsDir)) return []
  const out: TranscriptHandle[] = []
  for (const entry of readdirSync(sessionsDir)) {
    if (entry === '_inbox' || entry.startsWith('.')) continue
    const tp = join(sessionsDir, entry, 'transcript.json')
    if (existsSync(tp)) out.push({ sessionId: entry, path: tp })
  }
  return out
}
