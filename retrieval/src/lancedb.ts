import type { DenseRetriever } from './hybrid.js'
import type { ScoredChunk } from './types.js'

// LanceDB embeddings store (#43). Table schema + record builder are pure and
// tested; the actual lancedb connection is lazily imported so the workspace
// builds/tests without the native dep.

export const VECTOR_TABLE = 'chunks'

export interface VectorRecord {
  id: string
  kind: string
  seed: string
  session: string
  speaker_id: string | null
  start_ms: number | null
  end_ms: number | null
  text: string
  vector: number[]
  metadata: string // JSON
  text_sha: string
}

export interface IndexableArtifact {
  id: string
  kind: 'utterance' | 'highlight' | 'code' | 'theme' | 'term' | 'legacy_chunk'
  seed: string
  session: string
  speaker_id?: string | null
  start_ms?: number | null
  end_ms?: number | null
  text: string
  text_sha: string
  vector: number[]
  metadata?: Record<string, unknown>
}

/**
 * Build LanceDB rows from indexable artifacts. Idempotent on text_sha: the
 * first occurrence of a SHA wins, later duplicates are dropped (re-indexing
 * the same content produces the same rows).
 */
export function buildVectorRecords(artifacts: IndexableArtifact[]): VectorRecord[] {
  const seen = new Set<string>()
  const rows: VectorRecord[] = []
  for (const a of artifacts) {
    if (seen.has(a.text_sha)) continue
    seen.add(a.text_sha)
    rows.push({
      id: a.id,
      kind: a.kind,
      seed: a.seed,
      session: a.session,
      speaker_id: a.speaker_id ?? null,
      start_ms: a.start_ms ?? null,
      end_ms: a.end_ms ?? null,
      text: a.text,
      vector: a.vector,
      metadata: JSON.stringify(a.metadata ?? {}),
      text_sha: a.text_sha,
    })
  }
  return rows
}

/** The native lancedb table surface we depend on (a subset). Injected in tests. */
export interface LanceTable {
  search(vector: number[], k: number): Promise<Array<VectorRecord & { _distance: number }>>
}

/** A DenseRetriever backed by LanceDB. Needs a query embedder (text → vector)
 * and a table handle; both injected so fusion stays testable. */
export class LanceDBRetriever implements DenseRetriever {
  constructor(
    private readonly table: LanceTable,
    private readonly embedQuery: (q: string) => Promise<number[]>,
  ) {}

  async search(query: string, k: number): Promise<ScoredChunk[]> {
    const qv = await this.embedQuery(query)
    const rows = await this.table.search(qv, k)
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      text_sha: r.text_sha,
      // cosine distance → similarity score
      score: 1 - r._distance,
      metadata: {
        seed: r.seed,
        session: r.session,
        speaker_id: r.speaker_id,
        start_ms: r.start_ms,
        end_ms: r.end_ms,
        source_page: null,
        highlight_ids: [],
        code_ids: [],
        actor_type: 'agent',
        chunk_type: 'utterance',
      },
    }))
  }
}
