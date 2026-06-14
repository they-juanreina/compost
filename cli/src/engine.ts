/**
 * Public engine surface for in-process consumers (the Next.js web app, #119).
 *
 * The web UI reads via better-sqlite3 and performs every mutation through these
 * functions — the SAME write+emit path the CLI uses — so files and provenance
 * events never diverge between the two front-ends (ROADMAP: "mutations dispatch
 * the CLI engine"). Nothing here is re-implemented in web/lib.
 *
 * Exposed as the `@they-juanreina/compost-cli/engine` subpath so importing the
 * engine never drags in commander or the CLI program wiring.
 */

// ---- provenance primitives re-exported so web has a single engine import
export {
  type Action,
  type ActorType,
  type Event,
  type EventInput,
  EventWriter,
  reduce,
  type Snapshot,
  SnapshotStore,
} from '@they-juanreina/compost-provenance'
// ---- retrieval primitives re-exported (chat retrieval citations, #122)
export type { Chunk, ChunkMetadata, ScoredChunk } from '@they-juanreina/compost-retrieval'
// ---- errors
export { CompostError, type CompostErrorCode } from './errors.js'
// ---- artifact writes: create / endorse / reject / update (#119, #121)
export {
  CODEBOOK_STANCES,
  type CodebookStance,
  type CreateCategoryInput,
  type CreateCodebookInput,
  type CreateCodeInput,
  type CreatedArtifact,
  type CreateHighlightInput,
  type CreateMemoInput,
  type CreateThemeInput,
  createCategory,
  createCode,
  createCodebook,
  createHighlight,
  createMemo,
  createTheme,
  DEFAULT_CODEBOOK_ID,
  defaultResearcherId,
  endorseArtifact,
  ensurePrimaryCodebook,
  HUMAN_REF_RE,
  rejectArtifact,
  resolveCodebookId,
  updateArtifact,
} from './lib/artifacts.js'
// ---- blame: artifact lineage chain (#122)
export { type BlameEvent, type BlameResult, blame } from './lib/blame.js'
// ---- categories: second-cycle pattern-coding tier (ADR 0002)
export {
  type CategoryLink,
  linkCodeToCategory,
  listCategories,
  listCategoryLinks,
  resolveCategory,
  unlinkCodeFromCategory,
} from './lib/categories.js'
// ---- memos: analytic-memo artifact (ADR 0004)
export {
  DEFAULT_MEMO_TYPE,
  decodeAnchor,
  encodeAnchor,
  listMemos,
  type MemoAnchor,
  type MemoAnchorKind,
  MEMO_ANCHOR_KINDS,
  MEMO_TYPES,
  type MemoType,
  type MemoView,
  memosAbout,
  resolveMemoAnchors,
} from './lib/memos.js'
// ---- codebooks: list + lazy migration (ADR 0001 slice 1)
export {
  applyCodebookMigration,
  type CodebookMigrationPlan,
  type CodebookMigrationResult,
  listCodebooks,
  planCodebookMigration,
} from './lib/codebooks.js'
// ---- low-level event helpers (for callers that compose their own writes)
export {
  type AiInputBundle,
  type Author,
  artifactId,
  emitAgentCreate,
  emitCreate,
  emitEndorse,
  emitReject,
  emitUpdate,
  openSeedEvents,
} from './lib/events.js'
// ---- prompt journal: AGENTS.md read/parse/save (#122)
export {
  agentsPath,
  type JournalSaveResult,
  type JournalVersion,
  parseVersions,
  readJournal,
  saveJournal,
} from './lib/journal.js'
// ---- artifact reads: list / get current snapshots (#121 GET endpoints)
export { getArtifact, listArtifacts, type SnapshotView } from './lib/reads.js'
// ---- chat retrieval: hybrid BM25 + dense, no LLM call (#122)
export {
  buildDenseRetriever,
  type LoadedCorpus,
  loadSeedCorpus,
  type RetrievalMode,
  type RetrieveResult,
  retrieveChunks,
} from './lib/retrieve.js'
// ---- seed resolution (path-traversal hardened, #211)
export { resolveSeedPath } from './lib/seedResolve.js'
// ---- session reads (#120)
export {
  getSession,
  listSessions,
  type SessionSummary,
  type SessionView,
} from './lib/session.js'
