/**
 * Shared request/response interfaces for the v0.2 web API (#122 acceptance:
 * "all routes typed with shared TypeScript interfaces in web/lib/types.ts").
 * Imported by the route handlers and, later, the pages that consume them
 * (#123 home, #125 lineage modal, #129 chat panel, the agents journal page).
 */
import type { BlameResult, JournalVersion, SnapshotView } from '@they-juanreina/compost-cli/engine'

// ---- artifacts (#120/#121)
export type { SnapshotView } from '@they-juanreina/compost-cli/engine'

// ---- prompt journal / agents (#122)
export interface AgentsResponse {
  draft: string
  versions: JournalVersion[]
}
export interface SaveAgentsRequest {
  draft: string
  /** Ask the harness to re-run loops after saving. Accepted in v0.2 but not yet
   * acted on by the web server (loops run via the CLI/supervisor). */
  rerunLoops?: boolean
}
export interface SaveAgentsResponse {
  ok: true
  mode: 'git' | 'append'
  versions: number
  rerunRequested: boolean
}

// ---- blame / lineage (#122)
export type BlameResponse = BlameResult

// ---- chat retrieval (#122) — retrieval only; the host LLM does synthesis (#129)
export interface ChatRequest {
  question: string
  /** top-k chunks to return (default 5). */
  k?: number
}
export interface RetrievedChunk {
  session: string
  /** Resolved when the chunk is a whole utterance; null for window/highlight/page chunks. */
  utterance_id: string | null
  quote: string
  score: number
  chunk_type: string
}
export interface ChatResponse {
  question: string
  retrieved_chunks: RetrievedChunk[]
  k_used: number
  /** `hybrid` when a LanceDB vector index was used, `bm25` when text-only. */
  mode: 'hybrid' | 'bm25'
}

/** The artifact-mutation result the CRUD routes return (re-export for clients). */
export type ArtifactSnapshot = SnapshotView
