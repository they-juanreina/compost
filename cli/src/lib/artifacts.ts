import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { verbatimIncludes } from '@they-juanreina/compost-retrieval'
import type Database from 'better-sqlite3'

import { CompostError } from '../errors.js'
import { codebookSlugOf, qualifiedCodeId } from './codeRefs.js'
import {
  type AiInputBundle,
  type Author,
  artifactId,
  emitCreate,
  emitEndorse,
  emitReject,
  emitUpdate,
  eventsDbPath,
  openReadonlyEvents,
  openSeedEvents,
} from './events.js'
import {
  assertMemoType,
  DEFAULT_MEMO_TYPE,
  encodeAnchor,
  type MemoAnchor,
  type MemoType,
  resolveMemoAnchors,
} from './memos.js'
import { listArtifacts } from './reads.js'
import { encodeEvidence, resolveThemeEvidence, type ThemeEvidence } from './themes.js'

export interface CreatedArtifact {
  id: string // human/file id (H-NNN, C-slug, T-slug, CB-slug, CAT-slug, M-slug)
  artifact_id: string // SHA256(initial state) — the provenance content-address
  path: string // markdown file written
  event_id: string // the create event's ULID
}

/**
 * A codebook declares its interpretive standpoint up front (ADR 0001) —
 * Haraway's "situated knowledge" as a required field, validated CLI-side
 * because the event schema keeps payloads free-form by design.
 */
export const CODEBOOK_STANCES = ['inductive', 'deductive', 'in_vivo', 'framework'] as const
export type CodebookStance = (typeof CODEBOOK_STANCES)[number]

/** Every code belongs to a codebook; absent an explicit one, this is it.
 * Readers treat a missing `codebook_id` as this value (lazy migration). */
export const DEFAULT_CODEBOOK_ID = 'CB-primary'

// ---------------------------------------------------------------- helpers

/** Next sequential H-NNN in highlights/, scanning existing files. */
function nextHighlightId(dir: string): string {
  let max = 0
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = /^H-(\d+)\.md$/.exec(f)
      if (m) max = Math.max(max, Number.parseInt(m[1] as string, 10))
    }
  }
  return `H-${String(max + 1).padStart(3, '0')}`
}

/** Filesystem-safe slug for code/theme names. */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length === 0)
    throw new CompostError(
      'INVALID_INPUT',
      `Name has no slug-able characters: ${JSON.stringify(name)}`,
    )
  return s
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${formatYamlValue(v)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function formatYamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`
  if (typeof v === 'object' && v !== null) {
    const inner = Object.entries(v)
      .map(([k, val]) => `${k}: ${String(val)}`)
      .join(', ')
    return `{ ${inner} }`
  }
  return String(v)
}

// ---------------------------------------------------------------- create

/**
 * Write the markdown, then emit its create event — atomically. If the event
 * fails (e.g. schema validation: AI events require model + prompt_hash), roll
 * the file back so no code path ever leaves a `.md` without a matching create
 * event (#165). The caller guarantees `path` did not pre-exist (existsSync
 * check / fresh sequential id), so the rollback only removes our own write.
 */
function writeArtifactAtomic(
  seedPath: string,
  path: string,
  body: string,
  event: {
    artifactKind: string
    initialState: Record<string, unknown>
    author: Author
    inputs?: AiInputBundle
  },
): string {
  writeFileSync(path, body, 'utf8')
  const events = openSeedEvents(seedPath)
  try {
    return emitCreate(events, event).id
  } catch (err) {
    try {
      rmSync(path, { force: true }) // roll back the orphan-to-be
    } catch {
      // best-effort cleanup; surface the original (more useful) error regardless
    }
    throw err
  } finally {
    events.close()
  }
}

export interface CreateHighlightInput {
  sessionId: string
  utteranceId: string
  span: [number, number]
  text: string
  author: Author
  inputs?: AiInputBundle
}

export function createHighlight(seedPath: string, input: CreateHighlightInput): CreatedArtifact {
  const dir = join(seedPath, 'highlights')
  mkdirSync(dir, { recursive: true })
  const id = nextHighlightId(dir)

  // initialState is what the SHA addresses — the artifact's identity at birth.
  const initialState = {
    id,
    kind: 'highlight',
    session_id: input.sessionId,
    utterance_id: input.utteranceId,
    span: input.span,
    text: input.text,
  }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    session_id: input.sessionId,
    utterance_id: input.utteranceId,
    span: input.span,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${input.text}\n`

  const path = join(dir, `${id}.md`)
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'highlight',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateCodebookInput {
  name: string
  stance: CodebookStance
  description?: string
  author: Author
  inputs?: AiInputBundle
}

/**
 * Create a codebook — the lens/frame codes belong to (ADR 0001). Lives in
 * `codebooks/<slug>.md`, a sibling of `codebook/`, because status counts and
 * saturate parse every `.md` under `codebook/` as a code.
 */
export function createCodebook(seedPath: string, input: CreateCodebookInput): CreatedArtifact {
  if (!CODEBOOK_STANCES.includes(input.stance)) {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid stance ${JSON.stringify(input.stance)}. A codebook declares its standpoint: ${CODEBOOK_STANCES.join(' | ')}.`,
    )
  }
  const dir = join(seedPath, 'codebooks')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.name)
  const id = `CB-${name}`
  const description = input.description ?? ''
  const seedId = basename(seedPath)

  const initialState = {
    id,
    kind: 'codebook',
    seed_id: seedId,
    name,
    stance: input.stance,
    description,
  }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    name,
    stance: input.stance,
    seed_id: seedId,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${description}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Codebook "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'codebook',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateCategoryInput {
  name: string
  definition: string
  /** Codebook the category belongs to (name or CB- id). A category is
   * codebook-internal (ADR 0002) — it groups only codes within one frame.
   * Default: the seed's primary codebook. */
  codebookId?: string
  author: Author
  inputs?: AiInputBundle
}

/**
 * Create a category — the second-cycle / pattern-coding tier (ADR 0002): a
 * codebook-internal grouping of codes sitting between Code and Theme. Lives in
 * `categories/<slug>.md` (a sibling of codebook/, so the code-counting readers
 * never see it). Codes are linked to it via `link(code → category)` events
 * (see linkCodeToCategory); the category itself just carries name + definition.
 */
export function createCategory(seedPath: string, input: CreateCategoryInput): CreatedArtifact {
  const codebook_id = resolveCodebookId(seedPath, input.codebookId)
  const dir = join(seedPath, 'categories')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.name)
  const id = `CAT-${name}`

  const initialState = {
    id,
    kind: 'category',
    codebook_id,
    name,
    definition: input.definition,
  }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    name,
    codebook_id,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${input.definition}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Category "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'category',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

/**
 * Create the primary codebook iff absent — the structural default every code
 * lands in unless created with an explicit codebook. Researcher-authored (a
 * human invoked init/create), so it is born endorsed rather than [draft].
 * Idempotent on the `codebooks/primary.md` file.
 */
export function ensurePrimaryCodebook(seedPath: string): {
  id: string
  created: boolean
  artifact_id?: string
} {
  if (existsSync(join(seedPath, 'codebooks', 'primary.md'))) {
    return { id: DEFAULT_CODEBOOK_ID, created: false }
  }
  const created = createCodebook(seedPath, {
    name: 'primary',
    stance: 'inductive',
    description:
      'Default codebook: every code lands here unless created with an explicit codebook. Edit the stance and description to fit the study, or add lenses with `compost codebook new`.',
    author: { actorType: 'researcher', actorId: defaultResearcherId() },
  })
  return { id: created.id, created: true, artifact_id: created.artifact_id }
}

/**
 * Resolve a codebook reference to its `CB-` id. `CB-primary` is the implicit
 * default frame — it needs no artifact, so `undefined` / `primary` resolve
 * without a side-effect or existence check. Explicit non-primary refs accept a
 * name (`epistemology`) or CB- id and must already exist — a typo would
 * silently corrupt frame scoping (codes stamped, codings/agreement/saturate
 * filtered to a frame that doesn't exist), so unknown refs fail listing what is
 * available. Shared by `create code`, `recode`, `agreement`, and `saturate`.
 */
export function resolveCodebookId(seedPath: string, ref: string | undefined): string {
  if (ref === undefined) return DEFAULT_CODEBOOK_ID
  const id = ref.startsWith('CB-') ? ref : `CB-${slug(ref)}`
  if (id === DEFAULT_CODEBOOK_ID) return DEFAULT_CODEBOOK_ID

  // No event log yet ⇒ no codebooks exist; the only valid explicit ref would be
  // primary (handled above). Anything else is unknown — say so cleanly rather
  // than surfacing a raw "no events.sqlite".
  const noneAvailable = () =>
    new CompostError(
      'INVALID_INPUT',
      `No codebook "${id}" in this seed. Available: (none — create one with \`compost codebook new <name> --stance <stance>\`)`,
    )
  if (!existsSync(eventsDbPath(seedPath))) throw noneAvailable()

  const db = openReadonlyEvents(seedPath, 'No events.sqlite in seed.')
  try {
    const row = db
      .prepare(
        "SELECT artifact_id FROM events WHERE artifact_kind = 'codebook' AND action = 'create' AND json_extract(payload, '$.id') = ? LIMIT 1",
      )
      .get(id) as { artifact_id: string } | undefined
    if (row === undefined) {
      const names = (
        db
          .prepare(
            "SELECT json_extract(payload, '$.id') AS id FROM events WHERE artifact_kind = 'codebook' AND action = 'create' ORDER BY ts, rowid",
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
      throw new CompostError(
        'INVALID_INPUT',
        `No codebook "${id}" in this seed. Available: ${names.length > 0 ? names.join(', ') : '(none — create one with `compost codebook new <name> --stance <stance>`)'}`,
      )
    }
    return id
  } finally {
    db.close()
  }
}

/** The declared stance of a codebook. CB-primary is always inductive (and has
 * no artifact to read); other frames are read from their codebook artifact. */
function codebookStance(seedPath: string, codebookId: string): CodebookStance {
  if (codebookId === DEFAULT_CODEBOOK_ID) return 'inductive'
  // includeArchived: resolveCodebookId resolves a rejected codebook's id from
  // its create event, so a code can still be created under it — the in_vivo
  // check must keep enforcing rather than silently degrade to inductive (#268).
  for (const snap of listArtifacts(seedPath, 'codebook', { includeArchived: true })) {
    const s = snap.current_state as { id?: string; stance?: string }
    if (s.id === codebookId && CODEBOOK_STANCES.includes(s.stance as CodebookStance)) {
      return s.stance as CodebookStance
    }
  }
  return 'inductive'
}

/** The verbatim body text of a highlight (`highlights/<id>.md` after its
 * frontmatter). Empty string when the highlight has no file (event-only) or no
 * body — verbatimIncludes then simply won't match. */
function readHighlightBody(seedPath: string, highlightId: string): string {
  const path = join(seedPath, 'highlights', `${highlightId}.md`)
  if (!existsSync(path)) return ''
  const content = readFileSync(path, 'utf8')
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return (m === null ? content : content.slice(m[0].length)).trim()
}

export interface CreateCodeInput {
  name: string
  definition: string
  evidence?: string[]
  /** Codebook this code belongs to (name or CB- id). Default: the seed's
   * primary codebook, created on first use if absent. */
  codebookId?: string
  /** Lineage: the origin code this one was copied from (`compost codebook
   * duplicate`, #269). A bare/qualified code id for a same-seed source, or
   * `<seed>:<id>` for a cross-seed `--from` source. Recorded in the create
   * payload + frontmatter so `blame` on the duplicate shows where it came from.
   * Definitions travel; evidence does not — the copy enters un-grounded. */
  derivedFrom?: string
  author: Author
  inputs?: AiInputBundle
}

export function createCode(seedPath: string, input: CreateCodeInput): CreatedArtifact {
  const codebook_id = resolveCodebookId(seedPath, input.codebookId)
  const name = slug(input.name)
  // Codes are namespaced by frame on disk (#269, Option A): the id carries the
  // codebook slug and the file lives under codebook/<cb-slug>/, so two lenses
  // can each hold a `distrust` without colliding.
  const dir = join(seedPath, 'codebook', codebookSlugOf(codebook_id))
  mkdirSync(dir, { recursive: true })
  const id = qualifiedCodeId(codebook_id, name)
  const evidence = input.evidence ?? []

  // In-vivo codes (ADR 0001): the code's name must be the participant's actual
  // words — so it must appear verbatim in at least one cited evidence highlight.
  // Only enforced when the code's codebook declares the in_vivo stance.
  if (codebookStance(seedPath, codebook_id) === 'in_vivo') {
    if (evidence.length === 0) {
      throw new CompostError(
        'INVALID_INPUT',
        `In-vivo code "${input.name}" needs evidence: its name must be quoted verbatim from a highlight, so at least one --evidence highlight is required.`,
      )
    }
    const found = evidence.some((hid) =>
      verbatimIncludes(readHighlightBody(seedPath, hid), input.name),
    )
    if (!found) {
      throw new CompostError(
        'INVALID_INPUT',
        `In-vivo code name "${input.name}" does not appear verbatim in any of its evidence highlights (${evidence.join(', ')}). An in_vivo code must be the participant's actual words.`,
      )
    }
  }

  const initialState = {
    id,
    kind: 'code',
    codebook_id,
    name,
    definition: input.definition,
    evidence,
    ...(input.derivedFrom !== undefined ? { derived_from: input.derivedFrom } : {}),
  }
  const sha = artifactId(initialState)
  const body = `${frontmatter({
    id,
    name,
    codebook_id,
    evidence,
    ...(input.derivedFrom !== undefined ? { derived_from: input.derivedFrom } : {}),
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n${input.definition}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Code "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'code',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateThemeInput {
  name: string
  summary: string
  /** @deprecated Pass `evidence` instead. Legacy code-only support; lazy-mapped
   * to `evidence: codes.map(c => ({kind:'code', ref:c}))` (ADR 0002 §1, #266). */
  codes?: string[]
  /** Heterogeneous {code|category} support set (#266). Takes precedence over
   * `codes` when both are given. */
  evidence?: ThemeEvidence[]
  /** Theme frame. A CB- id (or name) scopes the theme to one lens; explicit
   * `null` marks a cross-lens theme (must cite ≥2 distinct codebooks); omitted
   * is inferred from the evidence frames. */
  codebookId?: string | null
  author: Author
  inputs?: AiInputBundle
}

export function createTheme(seedPath: string, input: CreateThemeInput): CreatedArtifact {
  const dir = join(seedPath, 'synthesis', 'themes')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.name)
  const id = `T-${name}`

  // Normalize codes[] → evidence[] (kind=code), then resolve frames + the
  // theme's codebook_id and enforce the cross-lens invariant (ADR 0002 §1).
  const rawEvidence: ThemeEvidence[] =
    input.evidence ?? (input.codes ?? []).map((ref) => ({ kind: 'code' as const, ref }))
  const { evidence, codebookId } = resolveThemeEvidence(seedPath, rawEvidence, input.codebookId)

  // SHA-addressed identity carries the structured evidence + frame. Field name
  // `codebook_id` matches the on-disk frontmatter; null = cross-lens.
  const evidenceState = evidence.map((e) => ({
    kind: e.kind,
    ref: e.ref,
    codebook_id: e.codebookId,
  }))
  const initialState = {
    id,
    kind: 'theme',
    name,
    summary: input.summary,
    evidence: evidenceState,
    codebook_id: codebookId,
  }
  const sha = artifactId(initialState)
  const title = input.name.trim()

  // Dual-write a legacy `codes[]` for the deprecation window: when every
  // evidence entry is a code, old readers that have not yet learned `evidence`
  // still resolve the theme. Omitted once any category/cross-lens enters.
  const codeOnly = evidence.every((e) => e.kind === 'code')
  const body = `${frontmatter({
    id,
    name,
    evidence: evidence.map(encodeEvidence),
    ...(codeOnly ? { codes: evidence.map((e) => e.ref) } : {}),
    codebook_id: codebookId,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n# ${title}\n\n${input.summary}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Theme "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'theme',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

export interface CreateMemoInput {
  title: string
  content: string
  /** The kind of reflection (ADR 0004 §5) — a constrained set, default freeform. */
  type?: MemoType
  /** What the memo is about: a heterogeneous anchor set
   * `{kind: highlight|code|category|theme|codebook|memo, ref}`. Zero anchors is
   * valid — a project-level reflexive memo. */
  anchors?: MemoAnchor[]
  /** Frame scope. A CB- id (or name) scopes the memo to one lens; explicit
   * `null` marks a cross-frame / project-level memo; omitted is inferred from
   * the anchors (one shared frame ⇒ that frame, else frame-less). */
  codebookId?: string | null
  author: Author
  inputs?: AiInputBundle
}

/**
 * Create an analytic memo (ADR 0004) — the analyst's dated, evolving
 * interpretive record. Lives in `synthesis/memos/M-<slug>.md` (a sibling of
 * synthesis/themes/). AI-drafted memos are born `[draft]` (actor_type=ai) until a
 * researcher endorses; researcher memos are born endorsed. Editing emits an
 * `update` event, so the append-only ledger carries Saldaña's "series of dated
 * snapshots." compost stores and versions the interpretation; it never authors it.
 */
export function createMemo(seedPath: string, input: CreateMemoInput): CreatedArtifact {
  const dir = join(seedPath, 'synthesis', 'memos')
  mkdirSync(dir, { recursive: true })
  const name = slug(input.title)
  const id = `M-${name}`
  const type = input.type === undefined ? DEFAULT_MEMO_TYPE : assertMemoType(input.type)
  const { anchors, codebookId } = resolveMemoAnchors(seedPath, input.anchors ?? [], input.codebookId)

  // SHA-addressed identity carries title + content + structured anchors + frame.
  const anchorState = anchors.map((a) => ({
    kind: a.kind,
    ref: a.ref,
    codebook_id: a.codebookId ?? null,
  }))
  const initialState = {
    id,
    kind: 'memo',
    type,
    title: input.title.trim(),
    content: input.content,
    anchors: anchorState,
    codebook_id: codebookId,
  }
  const sha = artifactId(initialState)
  const title = input.title.trim()
  const body = `${frontmatter({
    id,
    type,
    ...(anchors.length > 0 ? { anchors: anchors.map(encodeAnchor) } : {}),
    codebook_id: codebookId,
    artifact_id: sha,
    provenance: { actor_type: input.author.actorType, actor_id: input.author.actorId },
  })}\n# ${title}\n\n${input.content}\n`

  const path = join(dir, `${name}.md`)
  if (existsSync(path)) {
    throw new CompostError('INVALID_INPUT', `Memo "${id}" already exists at ${path}`)
  }
  const event_id = writeArtifactAtomic(seedPath, path, body, {
    artifactKind: 'memo',
    initialState,
    author: input.author,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
  })
  return { id, artifact_id: sha, path, event_id }
}

// ---------------------------------------------------------------- endorse

interface CreateEventRow {
  id: string
  artifact_kind: string
  /** actor_id of the create event — used to refuse a self-endorse (#236). */
  actor_id: string
}

/**
 * Human-id form for an artifact ref: `H-NNN`, `C-slug`, `T-slug`, `CB-slug`,
 * `CAT-slug`, `M-slug` — the id `compost create`/`compost codebook new`/`compost
 * memo new` prints. We accept it wherever a SHA prefix is accepted so the obvious
 * `endorse <id-from-create>` round-trip works (#168). The dash and non-hex chars
 * make it unambiguous vs a SHA prefix (`^[a-f0-9]{8,64}$`). Extending this set is
 * what lets endorse/reject/update/getArtifact resolve a new kind by its id —
 * `M-` was added for memos (ADR 0004).
 */
export const HUMAN_REF_RE = /^(?:CAT|CB|[CHMT])-[A-Za-z0-9_/-]+$/

/**
 * Look up a create event by the human id stored in its payload (initialState.id).
 * Returns undefined when the ref isn't a human id OR no matching create exists,
 * so callers can fall through to SHA-prefix / latest: handling.
 */
export function tryResolveHumanRef(
  db: Database.Database,
  ref: string,
): (CreateEventRow & { artifact_id: string }) | undefined {
  if (!HUMAN_REF_RE.test(ref)) return undefined
  const exact = db
    .prepare(
      "SELECT id, artifact_kind, artifact_id, actor_id FROM events WHERE action = 'create' AND json_extract(payload, '$.id') = ? ORDER BY ts, rowid LIMIT 1",
    )
    .get(ref) as (CreateEventRow & { artifact_id: string }) | undefined
  if (exact !== undefined) return exact

  // Bare code shorthand (#269): a `C-<slug>` with no frame resolves to the
  // qualified `C-<cb>/<slug>` when exactly one codebook holds that slug. Two
  // frames sharing the slug stay ambiguous (undefined → caller's not-found),
  // matching resolveCodeRef's error-and-list posture.
  if (/^C-[^/]+$/.test(ref)) {
    const rows = db
      .prepare(
        "SELECT id, artifact_kind, artifact_id, actor_id FROM events WHERE action = 'create' AND artifact_kind = 'code' AND json_extract(payload, '$.id') LIKE 'C-%/' || ? ORDER BY ts, rowid",
      )
      .all(ref.slice(2)) as (CreateEventRow & { artifact_id: string })[]
    if (rows.length === 1) return rows[0]
  }

  // Renamed code (#269 migrate-ids): the create event still carries the old
  // bare id, but an `update{field:id}` renamed it to `ref`. Map the rename
  // target back to the code's create event so blame/endorse on the new
  // qualified id resolve.
  if (ref.startsWith('C-')) {
    const renamed = db
      .prepare(
        "SELECT id, artifact_kind, artifact_id, actor_id FROM events WHERE action = 'create' AND artifact_kind = 'code' AND artifact_id IN (SELECT artifact_id FROM events WHERE action = 'update' AND json_extract(payload, '$.field') = 'id' AND json_extract(payload, '$.after') = ?) ORDER BY ts, rowid LIMIT 1",
      )
      .get(ref) as (CreateEventRow & { artifact_id: string }) | undefined
    if (renamed !== undefined) return renamed
  }
  return undefined
}

/**
 * Resolve an artifact ref (human id, full/prefix SHA, or `latest:<kind>=<seed>`)
 * to its create event row. Shared by endorse/reject/update so every mutation
 * path accepts the same refs `compost create`/blame print (#168). Throws
 * INVALID_INPUT only when the ref is neither human-, SHA-, nor latest-shaped;
 * returns undefined when it's well-shaped but matches no create event (callers
 * raise a clearer FILE_NOT_FOUND).
 */
function findCreateEvent(
  db: Database.Database,
  artifactRef: string,
): (CreateEventRow & { artifact_id: string }) | undefined {
  const human = tryResolveHumanRef(db, artifactRef)
  if (human !== undefined) return human
  const latest = /^latest:(\w+)=(.+)$/.exec(artifactRef)
  if (latest) {
    const kind = latest[1] as string
    return db
      .prepare(
        "SELECT id, artifact_kind, artifact_id, actor_id FROM events WHERE artifact_kind = ? AND action = 'create' ORDER BY ts DESC, rowid DESC LIMIT 1",
      )
      .get(kind) as (CreateEventRow & { artifact_id: string }) | undefined
  }
  if (/^[a-f0-9]{8,64}$/i.test(artifactRef)) {
    return db
      .prepare(
        "SELECT id, artifact_kind, artifact_id, actor_id FROM events WHERE artifact_id LIKE ? AND action = 'create' ORDER BY ts, rowid LIMIT 1",
      )
      .get(`${artifactRef.toLowerCase()}%`) as
      | (CreateEventRow & { artifact_id: string })
      | undefined
  }
  if (!HUMAN_REF_RE.test(artifactRef)) {
    // Not human-shaped, not SHA-shaped, not latest: → user typed something
    // unparseable. (Human-shaped refs that didn't resolve return undefined so
    // callers raise FILE_NOT_FOUND with a clearer message.)
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid artifact ref "${artifactRef}". Use the id from \`compost create\` (e.g. C-slug, H-001), a SHA256 prefix, or latest:<kind>=<seed>.`,
    )
  }
  return undefined
}

/** Latest event id on an artifact's timeline — the parent a new reject/update
 * event chains to (vs endorse, which chains to create for #168 round-tripping). */
function latestEventId(db: Database.Database, artifactId: string): string | undefined {
  const row = db
    .prepare('SELECT id FROM events WHERE artifact_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1')
    .get(artifactId) as { id: string } | undefined
  return row?.id
}

/**
 * Resolve an artifact ref (human id, full/prefix SHA, or `latest:<kind>=<seed>`)
 * to its create event, then emit a researcher endorse chaining it. Mirrors
 * blame's ref resolution so `compost endorse <id-from-create>` works (#168).
 */
export function endorseArtifact(
  seedPath: string,
  artifactRef: string,
  researcherId: string,
): {
  artifact_id: string
  endorse_event_id: string
  parent_event_id: string
  already_endorsed?: true
} {
  const db = openReadonlyEvents(seedPath, 'No events.sqlite in seed; nothing to endorse.')
  let createRow: (CreateEventRow & { artifact_id: string }) | undefined
  // Same (artifact_id, researcher) endorse already on the timeline → idempotent
  // no-op (#169). Looked up alongside the create row so we hold the read-only
  // connection once and avoid a stat/open dance.
  let existingEndorse: { id: string; parent_event: string | null } | undefined
  try {
    createRow = findCreateEvent(db, artifactRef)

    if (createRow !== undefined) {
      existingEndorse = db
        .prepare(
          "SELECT id, parent_event FROM events WHERE artifact_id = ? AND action = 'endorse' AND actor_id = ? ORDER BY ts, rowid LIMIT 1",
        )
        .get(createRow.artifact_id, researcherId) as
        | { id: string; parent_event: string | null }
        | undefined
    }
  } finally {
    db.close()
  }

  if (createRow === undefined) {
    throw new CompostError('FILE_NOT_FOUND', `No create event found for ref "${artifactRef}".`)
  }

  // Refuse a self-endorse: the actor who created an artifact can't also be the
  // one who endorses it (#236, defense-in-depth). The [draft]→endorsed gate is a
  // human approving an AI/agent suggestion; an agent endorsing under the same
  // actor_id it created with would collapse the gate. The endorsing identity is
  // bound to $COMPOST_USER server-side (commands/endorse.ts), not a tool arg.
  if (researcherId === createRow.actor_id) {
    throw new CompostError(
      'INVALID_INPUT',
      `Refusing to self-endorse: "${researcherId}" is the actor that created this artifact. Endorsement is a second actor approving it — set COMPOST_USER (or pass --researcher) to a human reviewer distinct from the author.`,
    )
  }

  if (existingEndorse !== undefined) {
    return {
      artifact_id: createRow.artifact_id,
      endorse_event_id: existingEndorse.id,
      parent_event_id: existingEndorse.parent_event ?? createRow.id,
      already_endorsed: true,
    }
  }

  const events = openSeedEvents(seedPath)
  try {
    const endorse = emitEndorse(events, {
      artifactKind: createRow.artifact_kind,
      artifactId: createRow.artifact_id,
      parentEventId: createRow.id,
      researcherId,
    })
    return {
      artifact_id: createRow.artifact_id,
      endorse_event_id: endorse.id,
      parent_event_id: createRow.id,
    }
  } finally {
    events.close()
  }
}

/**
 * Resolve an artifact ref to its create event, then emit a researcher reject
 * chaining the artifact's latest event. Reject archives (current_state is
 * preserved for audit) — the three-actor model's "delete", where nothing is
 * ever truly removed. Idempotent: a second reject by the same researcher is a
 * no-op returning the existing reject.
 */
export function rejectArtifact(
  seedPath: string,
  artifactRef: string,
  researcherId: string,
  note?: string,
): {
  artifact_id: string
  reject_event_id: string
  parent_event_id: string
  already_rejected?: true
} {
  const db = openReadonlyEvents(seedPath, 'No events.sqlite in seed; nothing to reject.')
  let resolved:
    | { createRow: CreateEventRow & { artifact_id: string }; parentEventId: string }
    | undefined
  let existingReject: { id: string; parent_event: string | null } | undefined
  try {
    const createRow = findCreateEvent(db, artifactRef)
    if (createRow !== undefined) {
      existingReject = db
        .prepare(
          "SELECT id, parent_event FROM events WHERE artifact_id = ? AND action = 'reject' AND actor_id = ? ORDER BY ts, rowid LIMIT 1",
        )
        .get(createRow.artifact_id, researcherId) as
        | { id: string; parent_event: string | null }
        | undefined
      resolved = {
        createRow,
        parentEventId: latestEventId(db, createRow.artifact_id) ?? createRow.id,
      }
    }
  } finally {
    db.close()
  }

  if (resolved === undefined) {
    throw new CompostError('FILE_NOT_FOUND', `No create event found for ref "${artifactRef}".`)
  }
  const { createRow, parentEventId } = resolved
  if (existingReject !== undefined) {
    return {
      artifact_id: createRow.artifact_id,
      reject_event_id: existingReject.id,
      parent_event_id: existingReject.parent_event ?? createRow.id,
      already_rejected: true,
    }
  }

  const events = openSeedEvents(seedPath)
  try {
    const reject = emitReject(events, {
      artifactKind: createRow.artifact_kind,
      artifactId: createRow.artifact_id,
      parentEventId,
      researcherId,
      ...(note !== undefined ? { note } : {}),
    })
    return {
      artifact_id: createRow.artifact_id,
      reject_event_id: reject.id,
      parent_event_id: parentEventId,
    }
  } finally {
    events.close()
  }
}

/**
 * Resolve an artifact ref, then emit a field-level update chaining the latest
 * event. The event log records `{ field, before, after }` so blame shows what
 * changed. `before` is best-effort context for the audit trail; the reducer
 * applies only `after`.
 */
export function updateArtifact(
  seedPath: string,
  artifactRef: string,
  patch: { field: string; before?: unknown; after: unknown },
  author: Author,
): { artifact_id: string; update_event_id: string; parent_event_id: string } {
  const db = openReadonlyEvents(seedPath, 'No events.sqlite in seed; nothing to update.')
  let resolved:
    | { createRow: CreateEventRow & { artifact_id: string }; parentEventId: string }
    | undefined
  try {
    const createRow = findCreateEvent(db, artifactRef)
    if (createRow !== undefined) {
      resolved = {
        createRow,
        parentEventId: latestEventId(db, createRow.artifact_id) ?? createRow.id,
      }
    }
  } finally {
    db.close()
  }
  if (resolved === undefined) {
    throw new CompostError('FILE_NOT_FOUND', `No create event found for ref "${artifactRef}".`)
  }
  const { createRow, parentEventId } = resolved

  const events = openSeedEvents(seedPath)
  try {
    const update = emitUpdate(events, {
      artifactKind: createRow.artifact_kind,
      artifactId: createRow.artifact_id,
      parentEventId,
      author,
      field: patch.field,
      before: patch.before,
      after: patch.after,
    })
    return {
      artifact_id: createRow.artifact_id,
      update_event_id: update.id,
      parent_event_id: parentEventId,
    }
  } finally {
    events.close()
  }
}

/** Read the configured researcher identity: COMPOST_USER env, else fallback. */
export function defaultResearcherId(): string {
  return process.env.COMPOST_USER || process.env.USER || 'researcher'
}
