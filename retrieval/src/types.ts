export type ActorType = 'researcher' | 'agent' | 'ai'

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
