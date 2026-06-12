export type ActorType = 'researcher' | 'agent' | 'ai'

/**
 * Provenance of the *text* for sourced-document corpora (#270). When a corpus
 * is a published interview, theory text, or archival document, standpoint is
 * the author's — there is no diarized participant to attach it to (ADR 0001).
 * This rides retrieval metadata so a citation over sourced material names the
 * source instead of fabricating a speaker. Distinct from `speaker_id`
 * (utterance-level diarization) and from the on-disk `source` file path.
 */
/** A structured (CSL-JSON-flavored) citation for a sourced document (#270).
 * `raw` is the free-form fallback; the structured fields enable a real
 * bibliography export later. All optional. */
export interface CitationMeta {
  /** CSL type, e.g. book, article-journal, interview, chapter. */
  type?: string
  /** Containing work — journal, book, or anthology title. */
  container_title?: string
  editors?: string[]
  pages?: string
  doi?: string
  /** Free-form citation string when the structured fields aren't supplied. */
  raw?: string
}

export interface SourceAttribution {
  author?: string
  title?: string
  /** Publication/creation year as a string (allows ranges, "n.d."). */
  year?: string
  citation?: CitationMeta
  url?: string
}

export interface ChunkMetadata {
  seed: string
  session: string
  speaker_id: string | null
  start_ms: number | null
  end_ms: number | null
  source_page: number | null
  highlight_ids: string[]
  code_ids: string[]
  actor_type: ActorType
  chunk_type: 'utterance' | 'window' | 'highlight' | 'term' | 'page'
  /** Author/citation of the source text (#270). Present only for sourced
   * documents; absent for diarized session recordings. */
  attribution?: SourceAttribution
}

export interface Chunk {
  id: string
  text: string
  text_sha: string
  metadata: ChunkMetadata
}

export interface ScoredChunk extends Chunk {
  score: number
}
