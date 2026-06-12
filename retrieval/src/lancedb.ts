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
  /** Source author/year promoted to columns so retrieval can filter sourced
   * documents by attribution (#270), the way speaker_id is filterable. Null for
   * diarized recordings. The rest of the citation rides the metadata blob. */
  author: string | null
  year: string | null
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
  author?: string | null
  year?: string | null
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
      author: a.author ?? null,
      year: a.year ?? null,
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

/** A lancedb query builder (the subset we use). `where` narrows by predicate;
 * `select` projects columns. Both the SHA-projection upsert path and the
 * metadata-update path read through this. */
export interface LanceQuery {
  where(predicate: string): LanceQuery
  select(cols: string[]): { toArray(): Promise<Array<Record<string, unknown>>> }
}

/** Subset of the native lancedb table surface our writer needs. Injected in tests. */
export interface LanceWritableTable {
  add(rows: VectorRecord[]): Promise<void>
  countRows(): Promise<number>
  query(): LanceQuery
  /** Set columns on the rows matching `where` (#275 metadata backfill). */
  update(opts: { where: string; values: Record<string, unknown> }): Promise<void>
}

/** A backfill patch for one already-embedded chunk (#275). */
export interface ChunkMetadataPatch {
  /** Chunk id (the LanceDB row id) to patch. */
  id: string
  /** Authoritative code_ids for the chunk — REPLACES the existing set (not a
   * union), so a recompute after an `unlink` shrinks it rather than growing. */
  code_ids?: string[]
  /** Codebook frame to stamp on the chunk. */
  codebook_id?: string
}

/** SQL string literal with single-quotes escaped, for a `where` predicate. */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Parse a row's JSON metadata blob into an object; {} on absence/garbage. */
function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Idempotent writer: filters incoming records against the SHAs already in the
 * table, appends the new ones. Re-running over identical content is a no-op.
 */
export class LanceDBWriter {
  constructor(private readonly table: LanceWritableTable) {}

  async upsertByTextSha(records: VectorRecord[]): Promise<number> {
    if (records.length === 0) return 0
    const existing = await this.table.query().select(['text_sha']).toArray()
    const have = new Set(existing.map((r) => r.text_sha))
    const fresh = records.filter((r) => !have.has(r.text_sha))
    if (fresh.length > 0) await this.table.add(fresh)
    return fresh.length
  }

  /**
   * Backfill `code_ids` / `codebook_id` onto already-embedded chunks (#275).
   * `upsertByTextSha` is add-only — it skips a row whose `text_sha` is already
   * present — so codes created or linked AFTER the ingest-time embed pass never
   * reach chunk metadata, leaving codebook-filtered retrieval hollow. This is
   * the missing update path: a read-modify-write of each row's JSON metadata
   * blob, keyed by chunk id. Returns the number of rows actually updated
   * (a patch whose id isn't in the table, or that carries no fields, is a
   * no-op). `code_ids` are REPLACED so the caller can recompute the
   * authoritative set from current code evidence each pass.
   */
  async updateChunkMetadata(patches: ChunkMetadataPatch[]): Promise<number> {
    let updated = 0
    for (const patch of patches) {
      if (patch.code_ids === undefined && patch.codebook_id === undefined) continue
      const where = `id = ${sqlString(patch.id)}`
      const rows = await this.table.query().where(where).select(['metadata']).toArray()
      if (rows.length === 0) continue
      const metadata = parseMetadata(rows[0]?.metadata)
      if (patch.code_ids !== undefined) metadata.code_ids = [...patch.code_ids]
      if (patch.codebook_id !== undefined) metadata.codebook_id = patch.codebook_id
      await this.table.update({ where, values: { metadata: JSON.stringify(metadata) } })
      updated += 1
    }
    return updated
  }

  async size(): Promise<number> {
    return this.table.countRows()
  }
}

/**
 * Lazily open the native lancedb connection and return a writer. Bootstraps
 * an empty table on first use; later calls just reopen.
 *
 * Kept lazy so the retrieval library remains importable (and unit-testable)
 * without the ~50MB native binary installed — callers without lancedb in
 * `node_modules` see a clear runtime error instead of an import failure at
 * package-load time.
 */
export async function openLanceDBForWrite(uri: string, vectorDim: number): Promise<LanceDBWriter> {
  let mod: typeof import('@lancedb/lancedb')
  try {
    mod = await import('@lancedb/lancedb')
  } catch (_e) {
    throw new Error(
      '@lancedb/lancedb is not installed. The embed-worker requires it. ' +
        'Run `pnpm install` from the repo root, then retry.',
    )
  }
  const db = await mod.connect(uri)
  const names = await db.tableNames()
  let table: Awaited<ReturnType<typeof db.openTable>>
  if (names.includes(VECTOR_TABLE)) {
    table = await db.openTable(VECTOR_TABLE)
  } else {
    // LanceDB infers the Arrow schema from the first row. The nullable columns
    // (speaker_id / start_ms / end_ms) MUST be non-null in the bootstrap
    // sentinel — LanceDB throws "Failed to infer data type" on a null at row 0.
    // We seed them with concrete placeholders (type → string / int64); real
    // rows can still carry nulls, since Arrow columns are nullable by default.
    // The sentinel is deleted immediately, so the placeholder values never
    // surface in a query.
    const sentinel: VectorRecord = {
      id: '__bootstrap__',
      kind: 'utterance',
      seed: '__bootstrap__',
      session: '__bootstrap__',
      speaker_id: '',
      start_ms: 0,
      end_ms: 0,
      author: '',
      year: '',
      text: '',
      vector: new Array(vectorDim).fill(0),
      metadata: '{}',
      text_sha: '__bootstrap__',
    }
    table = await db.createTable(VECTOR_TABLE, [sentinel as unknown as Record<string, unknown>])
    await table.delete("id = '__bootstrap__'")
  }
  return new LanceDBWriter(table as unknown as LanceWritableTable)
}

/**
 * Open the `chunks` table for reading and return a LanceDBRetriever, or null
 * when the index doesn't exist yet (no embed-worker run) or the native binary
 * isn't installed. Never throws — a missing/unavailable index means the caller
 * falls back to BM25-only retrieval, not an error.
 */
export async function openLanceDBForRead(
  uri: string,
  embedQuery: (q: string) => Promise<number[]>,
): Promise<LanceDBRetriever | null> {
  let mod: typeof import('@lancedb/lancedb')
  try {
    mod = await import('@lancedb/lancedb')
  } catch {
    return null // native binary absent → BM25-only
  }
  try {
    const db = await mod.connect(uri)
    const names = await db.tableNames()
    if (!names.includes(VECTOR_TABLE)) return null // index not built yet
    const nativeTable = await db.openTable(VECTOR_TABLE)
    // Adapt the native query builder to our minimal LanceTable.search shape.
    const table: LanceTable = {
      async search(vector: number[], k: number) {
        const rows = await nativeTable.search(vector).limit(k).toArray()
        return rows as Array<VectorRecord & { _distance: number }>
      },
    }
    return new LanceDBRetriever(table, embedQuery)
  } catch {
    return null
  }
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
        // Surface the attribution columns so a sourced-document filter (#270)
        // matches dense hits, not just BM25 ones.
        ...(r.author || r.year
          ? {
              attribution: {
                ...(r.author ? { author: r.author } : {}),
                ...(r.year ? { year: r.year } : {}),
              },
            }
          : {}),
      },
    }))
  }
}
