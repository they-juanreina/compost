export { BM25Index, tokenize } from './bm25.js'
export type { ChunkerOptions, ChunkerTranscript } from './chunker.js'
export { CHUNKER_VERSION, chunkTranscript, SILENCE_BOUNDARY_MS } from './chunker.js'
export {
  type AnthropicDocBlock,
  type CitableChunk,
  parseAnthropicCitations,
  toDocumentBlocks,
} from './citations_anthropic.js'
export {
  type Cluster,
  clusterByEmbedding,
  type EmbeddedItem,
  type SaturationPulse,
  saturationPulse,
  suggestCodeClusters,
} from './clustering.js'
export {
  cosineSimilarity,
  DEFAULT_BATCH_SIZE,
  DEFAULT_EMBED_MODEL,
  Embedder,
  type EmbedderOptions,
  type EmbeddingCache,
  type EmbedFn,
  type EmbedResult,
  MemoryCache,
  textSha,
} from './embeddings.js'
export type { DenseRetriever, HybridOptions, RetrievalFilters } from './hybrid.js'
export { HybridRetriever } from './hybrid.js'
export {
  buildVectorRecords,
  type IndexableArtifact,
  LanceDBRetriever,
  LanceDBWriter,
  type LanceTable,
  type LanceWritableTable,
  openLanceDBForRead,
  openLanceDBForWrite,
  VECTOR_TABLE,
  type VectorRecord,
} from './lancedb.js'
export { type CrossEncoder, rerank } from './rerank.js'
export { RRF_K, reciprocalRankFusion } from './rrf.js'
export type { Chunk, ChunkMetadata, ScoredChunk } from './types.js'
export {
  type Answer,
  type Claim,
  type EvidenceSet,
  INSUFFICIENT_EVIDENCE,
  validateAnswer,
  validateWithRetry,
} from './validator.js'
