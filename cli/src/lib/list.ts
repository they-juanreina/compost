import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { ActorType } from '@they-juanreina/compost-provenance'

import { CompostError } from '../errors.js'
import { DEFAULT_CODEBOOK_ID, resolveCodebookId } from './artifacts.js'
import { codeMarkdownPaths, tryResolveCodeRef } from './codeRefs.js'
import { listArtifacts, type SnapshotView } from './reads.js'
import { evidenceToCodeIds, type ThemeEvidence, type ThemeEvidenceKind } from './themes.js'

/**
 * `compost list <kind>` (ADR 0007 P2): a read-only, state-aware query over the
 * ledger — "what exists, and what is awaiting endorsement?". Folds the canonical
 * event log (via `listArtifacts`); writes nothing.
 *
 * Kinds are a constrained set. Memos, codebooks and categories already have
 * their own `list` verbs (`memo list`, `codebook list`, `category list`), so
 * they are deliberately NOT a second name here (§7).
 */
export const LISTABLE_KINDS = ['highlight', 'code', 'theme'] as const
export type ListableKind = (typeof LISTABLE_KINDS)[number]

/** An artifact's trust state, derived from its snapshot. `draft` = not
 * human-approved (an AI/agent suggestion awaiting `endorse`); `endorsed` =
 * human-approved (endorsed, or researcher-authored and so born approved);
 * `archived` = rejected (`reject` archives, never deletes). */
export const ARTIFACT_STATES = ['draft', 'endorsed', 'archived'] as const
export type ArtifactState = (typeof ARTIFACT_STATES)[number]
export const STATE_FILTERS = [...ARTIFACT_STATES, 'all'] as const
export type StateFilter = (typeof STATE_FILTERS)[number]

export type StateCounts = Record<ArtifactState, number>

export function artifactState(snap: { human_approved: boolean; archived: boolean }): ArtifactState {
  if (snap.archived) return 'archived'
  return snap.human_approved ? 'endorsed' : 'draft'
}

export function assertListableKind(kind: string): ListableKind {
  if ((LISTABLE_KINDS as readonly string[]).includes(kind)) return kind as ListableKind
  const hint =
    kind === 'memo' || kind === 'codebook' || kind === 'category'
      ? ` ${kind}s have their own verb: \`compost ${kind} list\`.`
      : ''
  throw new CompostError(
    'INVALID_INPUT',
    `Unknown kind "${kind}". Use one of: ${LISTABLE_KINDS.join(', ')}.${hint}`,
  )
}

export function assertStateFilter(state: string): StateFilter {
  if ((STATE_FILTERS as readonly string[]).includes(state)) return state as StateFilter
  throw new CompostError(
    'INVALID_INPUT',
    `Unknown state "${state}". Use one of: ${STATE_FILTERS.join(', ')} (default: draft + endorsed, i.e. not archived).`,
  )
}

/** One quote a code/theme stands on. `quote`/`session_id`/`utterance_id` are
 * null only when the highlight is neither in the ledger nor on disk. */
export interface EvidenceQuote {
  id: string
  quote: string | null
  session_id: string | null
  utterance_id: string | null
  /** The highlight's own trust state; null for a file-only highlight. */
  state: ArtifactState | null
}

export interface ThemeEvidenceDetail {
  kind: ThemeEvidenceKind
  ref: string
  codebook_id: string | null
  /** Codes this entry stands for: the code itself, or a category's
   * primary-linked members (same walk as `saturate`). Empty for a memo. */
  codes: string[]
  /** A memo is an analytic annotation, not participant data — no quotes. */
  highlights: EvidenceQuote[]
}

export interface ListedArtifact {
  id: string
  artifact_id: string
  kind: ListableKind
  state: ArtifactState
  /** Highlight: the quote. Code / theme: its name. */
  label: string
  author: { actor_type: ActorType; actor_id: string }
  created_at: string
  updated_at: string
  /** Null while a draft. `basis: endorsed` = an explicit endorse event;
   * `researcher_authored` = born approved (a researcher created it). */
  endorsement: {
    basis: 'endorsed' | 'researcher_authored'
    by: string
    at: string
  } | null
  /** Set when archived (rejected). */
  archive: { by: string | null; at: string | null; note: string | null } | null
  session_id?: string
  utterance_id?: string
  codebook_id?: string | null
  definition?: string
  summary?: string
  /** With `evidence: true`. Code: its highlights; theme: its evidence set. */
  evidence?: EvidenceQuote[] | ThemeEvidenceDetail[]
}

export interface ListResult {
  kind: ListableKind
  state: StateFilter | 'active'
  codebook?: string
  count: number
  items: ListedArtifact[]
  /** Markdown files of this kind with no create event in the ledger (sample
   * fixture, hand-authored, imported). They have no provenance, hence no
   * state — surfaced rather than silently dropped. Seed-relative paths. */
  file_only: Array<{ id: string; path: string }>
}

export interface ListOptions {
  /** Default (undefined): draft + endorsed, i.e. not archived. */
  state?: StateFilter
  /** Codebook ref (name or CB- id). Applies to code and theme only. */
  codebook?: string
  /** Expand each item's evidence down to quotes. Code and theme only. */
  evidence?: boolean
}

/** Per-state counts of every ledger-recorded artifact of `kind` (any kind
 * string — status also counts memos). */
export function countByState(seedPath: string, kind: string): StateCounts {
  const counts: StateCounts = { draft: 0, endorsed: 0, archived: 0 }
  for (const snap of listArtifacts(seedPath, kind, { includeArchived: true })) {
    counts[artifactState(snap)] += 1
  }
  return counts
}

export function listByKind(seedPath: string, kindArg: string, opts: ListOptions = {}): ListResult {
  const kind = assertListableKind(kindArg)
  if (opts.codebook !== undefined && kind === 'highlight') {
    throw new CompostError(
      'INVALID_INPUT',
      '--codebook applies to code and theme only (a highlight belongs to no frame). Drop it, or run `compost list code --codebook <ref>`.',
    )
  }
  if (opts.evidence === true && kind === 'highlight') {
    throw new CompostError(
      'INVALID_INPUT',
      '--evidence applies to code and theme only (a highlight is itself the quote). Drop it to list highlights.',
    )
  }
  const codebookId =
    opts.codebook !== undefined ? resolveCodebookId(seedPath, opts.codebook) : undefined

  const snaps = listArtifacts(seedPath, kind, { includeArchived: true })
  const lookup = new EvidenceLookup(seedPath)

  const items: ListedArtifact[] = []
  for (const snap of snaps) {
    const state = artifactState(snap)
    if (
      opts.state === undefined ? state === 'archived' : opts.state !== 'all' && opts.state !== state
    )
      continue
    if (codebookId !== undefined && !inCodebook(kind, snap, codebookId)) continue
    const item = toItem(kind, snap, state)
    if (opts.evidence === true) {
      item.evidence =
        kind === 'code'
          ? lookup.quotes(stringArray(snap.current_state.evidence))
          : lookup.themeEvidence(themeEvidenceOf(snap))
    }
    items.push(item)
  }

  const recorded = new Set(snaps.map((s) => String(s.current_state.id ?? '')))
  return {
    kind,
    state: opts.state ?? 'active',
    ...(codebookId !== undefined ? { codebook: codebookId } : {}),
    count: items.length,
    items,
    file_only: fileOnly(seedPath, kind, recorded),
  }
}

// --------------------------------------------------------------- internals

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function themeEvidenceOf(snap: SnapshotView): ThemeEvidence[] {
  const s = snap.current_state
  if (Array.isArray(s.evidence)) {
    const out: ThemeEvidence[] = []
    for (const e of s.evidence as Array<Record<string, unknown>>) {
      const kind = str(e?.kind) as ThemeEvidenceKind | undefined
      const ref = str(e?.ref)
      if (kind === undefined || ref === undefined) continue
      const cb = str(e.codebook_id)
      out.push({ kind, ref, ...(cb !== undefined ? { codebookId: cb } : {}) })
    }
    return out
  }
  // Legacy code-only theme (ADR 0002 lazy map).
  return stringArray(s.codes).map((ref) => ({ kind: 'code' as const, ref }))
}

function inCodebook(kind: ListableKind, snap: SnapshotView, codebookId: string): boolean {
  const s = snap.current_state
  if (kind === 'code') return (str(s.codebook_id) ?? DEFAULT_CODEBOOK_ID) === codebookId
  // A theme is in a frame when scoped to it, or — cross-lens (null) — when any
  // of its evidence comes from it.
  if (str(s.codebook_id) === codebookId) return true
  return themeEvidenceOf(snap).some((e) => e.codebookId === codebookId)
}

function toItem(kind: ListableKind, snap: SnapshotView, state: ArtifactState): ListedArtifact {
  const s = snap.current_state
  const endorsementRaw = s._endorsement as
    | { endorsed_by?: unknown; endorsed_at?: unknown }
    | undefined
  let endorsement: ListedArtifact['endorsement'] = null
  if (state !== 'draft' && endorsementRaw !== undefined) {
    endorsement = {
      basis: 'endorsed',
      by: str(endorsementRaw.endorsed_by) ?? '',
      at: str(endorsementRaw.endorsed_at) ?? '',
    }
  } else if (state === 'endorsed' && snap.created_by.actor_type === 'researcher') {
    endorsement = {
      basis: 'researcher_authored',
      by: snap.created_by.actor_id,
      at: snap.created_at,
    }
  }
  const reason = s._archive_reason as { note?: unknown } | undefined
  const archive: ListedArtifact['archive'] = snap.archived
    ? {
        by: str(s._archived_by) ?? null,
        at: str(s._archived_at) ?? null,
        note: str(reason?.note) ?? null,
      }
    : null

  const base: ListedArtifact = {
    id: str(s.id) ?? snap.artifact_id,
    artifact_id: snap.artifact_id,
    kind,
    state,
    label: (kind === 'highlight' ? str(s.text) : str(s.name)) ?? '',
    author: snap.created_by,
    created_at: snap.created_at,
    updated_at: snap.last_event_ts,
    endorsement,
    archive,
  }
  if (kind === 'highlight') {
    return { ...base, session_id: str(s.session_id) ?? '', utterance_id: str(s.utterance_id) ?? '' }
  }
  if (kind === 'code') {
    return {
      ...base,
      codebook_id: str(s.codebook_id) ?? DEFAULT_CODEBOOK_ID,
      definition: str(s.definition) ?? '',
    }
  }
  return {
    ...base,
    codebook_id: s.codebook_id === null ? null : (str(s.codebook_id) ?? null),
    summary: str(s.summary) ?? '',
  }
}

/** Resolves evidence refs to quotes. Reads each kind's snapshots once. */
class EvidenceLookup {
  private highlights?: Map<string, SnapshotView>
  private codes?: Map<string, SnapshotView>

  constructor(private readonly seedPath: string) {}

  private byId(kind: string): Map<string, SnapshotView> {
    const m = new Map<string, SnapshotView>()
    for (const snap of listArtifacts(this.seedPath, kind, { includeArchived: true })) {
      const id = str(snap.current_state.id)
      if (id !== undefined) m.set(id, snap)
    }
    return m
  }

  quotes(highlightIds: string[]): EvidenceQuote[] {
    this.highlights ??= this.byId('highlight')
    return highlightIds.map((id) => {
      const snap = this.highlights?.get(id)
      if (snap !== undefined) {
        const s = snap.current_state
        return {
          id,
          quote: str(s.text) ?? null,
          session_id: str(s.session_id) ?? null,
          utterance_id: str(s.utterance_id) ?? null,
          state: artifactState(snap),
        }
      }
      return { ...readHighlightFile(this.seedPath, id), id, state: null }
    })
  }

  private codeHighlights(codeRef: string): string[] {
    this.codes ??= this.byId('code')
    const snap =
      this.codes.get(codeRef) ??
      this.codes.get(tryResolveCodeRef(this.seedPath, codeRef)?.id ?? codeRef)
    return snap === undefined ? [] : stringArray(snap.current_state.evidence)
  }

  themeEvidence(entries: ThemeEvidence[]): ThemeEvidenceDetail[] {
    return entries.map((e) => {
      const codes = e.kind === 'memo' ? [] : evidenceToCodeIds(this.seedPath, [e])
      const ids = [...new Set(codes.flatMap((c) => this.codeHighlights(c)))]
      return {
        kind: e.kind,
        ref: e.ref,
        codebook_id: e.codebookId ?? null,
        codes,
        highlights: this.quotes(ids),
      }
    })
  }
}

/** Quote detail from `highlights/<id>.md` for a highlight with no create event. */
function readHighlightFile(seedPath: string, id: string): Omit<EvidenceQuote, 'id' | 'state'> {
  const path = join(seedPath, 'highlights', `${id}.md`)
  if (!/^H-[A-Za-z0-9_-]+$/.test(id) || !existsSync(path)) {
    return { quote: null, session_id: null, utterance_id: null }
  }
  const text = readFileSync(path, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const field = (name: string): string | null => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(fm?.[1] ?? '')
    return m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null
  }
  const body = (fm === null ? text : text.slice(fm[0].length)).trim()
  return {
    quote: body.length > 0 ? body : null,
    session_id: field('session_id'),
    utterance_id: field('utterance_id'),
  }
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
}

function fileOnly(
  seedPath: string,
  kind: ListableKind,
  recorded: Set<string>,
): Array<{ id: string; path: string }> {
  const paths =
    kind === 'highlight'
      ? markdownFiles(join(seedPath, 'highlights'))
      : kind === 'code'
        ? codeMarkdownPaths(seedPath)
        : markdownFiles(join(seedPath, 'synthesis', 'themes'))
  const out: Array<{ id: string; path: string }> = []
  for (const p of paths) {
    const m = /^id:\s*(\S+)\s*$/m.exec(readFileSync(p, 'utf8').split(/\r?\n---/)[0] ?? '')
    const id = m?.[1]?.replace(/^["']|["']$/g, '')
    if (id !== undefined && !recorded.has(id)) out.push({ id, path: relative(seedPath, p) })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
