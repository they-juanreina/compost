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
// ---- errors
export { CompostError, type CompostErrorCode } from './errors.js'
// ---- artifact writes: create / endorse / reject / update (#119, #121)
export {
  type CreateCodeInput,
  type CreatedArtifact,
  type CreateHighlightInput,
  type CreateThemeInput,
  createCode,
  createHighlight,
  createTheme,
  defaultResearcherId,
  endorseArtifact,
  HUMAN_REF_RE,
  rejectArtifact,
  updateArtifact,
} from './lib/artifacts.js'
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
// ---- artifact reads: list / get current snapshots (#121 GET endpoints)
export { getArtifact, listArtifacts, type SnapshotView } from './lib/reads.js'
// ---- seed resolution (path-traversal hardened, #211)
export { resolveSeedPath } from './lib/seedResolve.js'
// ---- session reads (#120)
export {
  getSession,
  listSessions,
  type SessionSummary,
  type SessionView,
} from './lib/session.js'
