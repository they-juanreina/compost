import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { CompostError, isCompostError } from '../errors.js'
import { formatYamlValue, updateArtifact } from './artifacts.js'
import { resolveCategory } from './categories.js'
import {
  lookupCodeRef,
  parseCodeId,
  qualifiedCodeId,
  resolveCodeRef,
  tryResolveCodeRef,
} from './codeRefs.js'
import { type Author, openSeedEvents } from './events.js'
import { type ArtifactState, artifactState } from './list.js'
import { getArtifact } from './reads.js'
import {
  encodeEvidence,
  resolveThemeEvidence,
  type ThemeEvidence,
  type ThemeEvidenceKind,
  themeEvidenceFromState,
} from './themes.js'

/**
 * `compost theme add|remove` (#335, ADR 0007 decision 4 — "verb first"): change
 * the evidence set of an existing theme. Until now the set was fixed at
 * `create theme`; the theme board's one interaction (drag a code into or out of
 * a theme) had nothing in the core to call.
 *
 * compost records the researcher's decision — it never proposes what belongs in
 * a theme. Every invariant is enforced here, once, so the CLI verb, the MCP
 * tools and the future board honor them identically:
 *
 * - **Provenance.** A change is ONE append-only `update` event on the theme
 *   (`field: evidence`, with `before`/`after`), tagged with its actor. A
 *   researcher editing an AI `[draft]` does not endorse it — `update` never
 *   touches `human_approved`.
 * - **Endorsement gate.** An `ai` actor may edit evidence only while the theme
 *   is still a draft. On an endorsed theme the edit is refused: the reducer
 *   would keep `human_approved` true, so the researcher's endorsement would
 *   silently cover a set they never saw. (The general form of this gap — any
 *   AI `update` on an endorsed artifact — is #337; this guard is per-verb.)
 * - **No stale decisions.** Everything above is decided from one snapshot, and
 *   the event is appended only if that snapshot is still the theme's latest
 *   state (`updateArtifact`'s `expectedParent`). An endorse, a reject or another
 *   edit that lands in between makes the write a `CONFLICT`, not a lost update
 *   or an AI change riding in behind an endorsement.
 * - **Frames.** The edited set goes through `resolveThemeEvidence` with the
 *   theme's own frame: a single-lens theme stays in its codebook, a cross-lens
 *   theme keeps ≥2 codebooks, and the verb never flips a theme's lens.
 * - **No empty set.** A removal may not strip the last code/category, nor the
 *   last evidence of any kind; retiring a theme is `compost reject`.
 * - **Idempotent.** Adding what is present / removing what is absent changes
 *   nothing: no event, no file write.
 * - **Markdown follows the ledger.** `saturate` reads theme frontmatter, so the
 *   `evidence` line (and the legacy `codes` dual-write) is restamped with the
 *   event: temp file → event → rename, the temp removed if the event fails, and
 *   the rename ordered by the ledger's write lock so two edits cannot leave the
 *   older set on disk.
 */

export interface ThemeEvidenceEdit {
  /** `code` / `category` refs to add (name, bare or qualified id). */
  add?: ThemeEvidence[]
  /** Evidence entries to remove. Any kind — a `memo` entry already on a theme
   * stays removable even though one can no longer be added. */
  remove?: ThemeEvidence[]
}

/** One evidence entry as it is stored on the theme (and in the event payload). */
export interface ThemeEvidenceEntry {
  kind: ThemeEvidenceKind
  ref: string
  codebook_id?: string
}

export interface ThemeEvidenceEditResult {
  id: string
  artifact_id: string
  /** False for a clean no-op — no event was emitted and nothing was written. */
  changed: boolean
  /** The theme's trust state, which an evidence edit never changes. */
  state: ArtifactState
  added: ThemeEvidenceEntry[]
  removed: ThemeEvidenceEntry[]
  /** Asked to add, but already on the theme (no-op for that entry). */
  already_present: ThemeEvidenceEntry[]
  /** Asked to remove, but not on the theme (no-op for that entry). */
  not_present: ThemeEvidenceEntry[]
  /** The theme's evidence set after the call. */
  evidence: ThemeEvidenceEntry[]
  /** The theme's frame — a CB- id, or null for cross-lens. Never changed here.
   * For a pre-#266 theme that never recorded one, the frame its evidence infers. */
  codebook_id: string | null
  /** Present only when `changed`. */
  update_event_id?: string
  parent_event_id?: string
  /** Whether the theme's markdown frontmatter was restamped. False on a no-op,
   * and for a theme with no markdown file (the event still carries the truth). */
  file_rewritten: boolean
  /** Set when the event landed but an existing markdown file could NOT be
   * restamped (unreadable frontmatter): file readers still see the old set. */
  warning?: string
}

/**
 * Test seam. Each hook runs where another writer's event could interleave with
 * this edit, so a test can play that writer deterministically. Not a feature:
 * no surface passes it.
 */
export interface ThemeEvidenceEditHooks {
  /** After the snapshot is read and every check has passed, before the event. */
  beforeWrite?: () => void
  /** After the event has committed, before the markdown is renamed into place. */
  afterEvent?: () => void
}

function toEntry(e: ThemeEvidence): ThemeEvidenceEntry {
  return {
    kind: e.kind,
    ref: e.ref,
    ...(e.codebookId !== undefined ? { codebook_id: e.codebookId } : {}),
  }
}

/**
 * Identity of an evidence entry for set comparison: its kind plus the canonical
 * id its ref resolves to, so a bare `C-distrust`, a name, and the qualified
 * `C-primary/distrust` are the same entry.
 *
 * Two ways a code ref can fail to resolve, handled differently:
 * - **Unknown** (its code was rejected): key on the raw ref, so the entry can
 *   still be removed by the ref it is stored under.
 * - **Ambiguous** (a bare ref that ≥2 codebooks now hold — e.g. after `codebook
 *   duplicate`): an entry `stored` on the theme carries the frame it was added
 *   in, and that picks the candidate. A `requested` ref carries no frame, so
 *   guessing is refused with the resolver's "qualify it" error.
 */
function evidenceKey(seedPath: string, e: ThemeEvidence, role: 'stored' | 'requested'): string {
  if (e.kind === 'code') {
    const found = lookupCodeRef(seedPath, e.ref)
    if (found.status === 'resolved') return `code:${found.code.id}`
    if (found.status === 'ambiguous') {
      if (e.codebookId !== undefined) {
        const qualified = qualifiedCodeId(e.codebookId, parseCodeId(e.ref).codeSlug)
        return `code:${tryResolveCodeRef(seedPath, qualified)?.id ?? qualified}`
      }
      if (role === 'requested') throw found.error
    }
    return `code:${e.ref}`
  }
  if (e.kind === 'category') {
    try {
      return `category:${resolveCategory(seedPath, e.ref).id}`
    } catch (err) {
      if (!isCompostError(err)) throw err
      return `category:${e.ref}`
    }
  }
  return `${e.kind}:${e.ref}`
}

const label = (e: { kind: string; ref: string }): string => `${e.kind}:${e.ref}`

export function editThemeEvidence(
  seedPath: string,
  themeRef: string,
  edit: ThemeEvidenceEdit,
  author: Author,
  hooks: ThemeEvidenceEditHooks = {},
): ThemeEvidenceEditResult {
  const snap = getArtifact(seedPath, 'theme', themeRef)
  if (snap === null) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No theme "${themeRef}" in this seed's ledger. Pass a theme id (T-<slug>) or a SHA prefix — \`compost list theme --state all\` shows what exists (a theme it reports under file_only has no create event, so it has no provenance to edit).`,
    )
  }
  const state = snap.current_state
  const id = typeof state.id === 'string' ? state.id : themeRef
  const trust = artifactState(snap)

  if (trust === 'archived') {
    throw new CompostError(
      'INVALID_INPUT',
      `Theme "${id}" is archived (rejected) — its evidence is kept as it was for audit and can no longer be edited. Create a new theme instead: \`compost create theme --name <name> --summary <text> --evidence <kind:ref,…>\`.`,
    )
  }
  // The endorsement gate (decision 2.2). `update` leaves human_approved as it
  // is, so an AI edit to an endorsed theme would ride on an endorsement given
  // to a different evidence set. Refused before anything else is looked at —
  // even a would-be no-op — so the answer never depends on the arguments. The
  // write below is conditional on this same snapshot, so the answer cannot go
  // stale between here and the event either.
  if (author.actorType === 'ai' && trust === 'endorsed') {
    throw new CompostError(
      'INVALID_INPUT',
      `Theme "${id}" is endorsed, and an AI actor may change a theme's evidence only while the theme is still a [draft]. Do not retry: tell the researcher which evidence you would add or remove and why, and ask them to run \`compost theme add|remove ${id} --evidence <kind:ref>\` themselves.`,
    )
  }

  const adds = edit.add ?? []
  const removes = edit.remove ?? []
  if (adds.length === 0 && removes.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      'Nothing to add or remove — pass at least one evidence ref: --evidence kind:ref[,kind:ref…], e.g. code:C-distrust,category:CAT-trust.',
    )
  }

  const current = themeEvidenceFromState(state)
  const currentKeys = current.map((e) => evidenceKey(seedPath, e, 'stored'))

  // ---- add: code | category only, resolved to the canonical id + frame.
  const added: ThemeEvidence[] = []
  const addedKeys = new Set<string>()
  const alreadyPresent: ThemeEvidence[] = []
  const alreadyKeys = new Set<string>()
  for (const req of adds) {
    if (req.kind === 'memo') {
      throw new CompostError(
        'INVALID_INPUT',
        `\`theme add\` takes code or category evidence only; "${label(req)}" was refused. A memo id (M-NNN) is a per-machine sequence number, and no new reference may be keyed on one until references move to artifact_id (ADR 0008 §5, #317). To relate the memo to this theme, anchor it from the memo side: \`compost memo cite ${req.ref} --anchor theme:${id}\`. (Memo evidence already on a theme can still be removed.)`,
      )
    }
    if (req.kind !== 'code' && req.kind !== 'category') {
      throw new CompostError(
        'INVALID_INPUT',
        `Evidence kind must be code | category; got "${String(req.kind)}" in "${label(req)}".`,
      )
    }
    // Strict on the way in: an unknown or ambiguous ref is refused with the
    // resolver's own message (known codes / qualified candidates / available
    // categories), so a typo never lands as evidence.
    let entry: ThemeEvidence
    if (req.kind === 'code') {
      const code = resolveCodeRef(seedPath, req.ref)
      entry = { kind: 'code', ref: code.id, codebookId: code.codebookId }
    } else {
      const cat = resolveCategory(seedPath, req.ref)
      entry = { kind: 'category', ref: cat.id, codebookId: cat.codebook_id }
    }
    const key = label(entry)
    if (addedKeys.has(key) || alreadyKeys.has(key)) continue // same entry twice in one call
    const existing = currentKeys.indexOf(key)
    if (existing !== -1) {
      alreadyKeys.add(key)
      alreadyPresent.push(current[existing] as ThemeEvidence)
      continue
    }
    addedKeys.add(key)
    added.push(entry)
  }

  // ---- remove: any kind. Tolerant of a ref that no longer resolves (unknown);
  // an ambiguous one is refused inside evidenceKey rather than reported absent.
  const removeKeys = new Set<string>()
  const notPresent: ThemeEvidence[] = []
  const notPresentKeys = new Set<string>()
  for (const req of removes) {
    const key = evidenceKey(seedPath, req, 'requested')
    if (addedKeys.has(key) || alreadyKeys.has(key)) {
      throw new CompostError(
        'INVALID_INPUT',
        `"${label(req)}" is in both the add set and the remove set — drop it from one of them.`,
      )
    }
    if (currentKeys.includes(key)) removeKeys.add(key)
    else if (!notPresentKeys.has(key)) {
      notPresentKeys.add(key)
      notPresent.push(req)
    }
  }
  const removed = current.filter((_, i) => removeKeys.has(currentKeys[i] as string))
  const kept = current.filter((_, i) => !removeKeys.has(currentKeys[i] as string))

  // The theme's own frame: a CB- id = single-lens, null = cross-lens, and
  // undefined on a pre-#266 theme that never recorded one.
  const frame: string | null | undefined =
    typeof state.codebook_id === 'string'
      ? state.codebook_id
      : state.codebook_id === null
        ? null
        : undefined
  const base = {
    id,
    artifact_id: snap.artifact_id,
    state: trust,
    already_present: alreadyPresent.map(toEntry),
    not_present: notPresent.map(toEntry),
  }

  // Idempotent no-op: nothing to change ⇒ no event, no write.
  if (added.length === 0 && removed.length === 0) {
    return {
      ...base,
      codebook_id: frame !== undefined ? frame : inferredFrame(seedPath, current),
      changed: false,
      added: [],
      removed: [],
      evidence: current.map(toEntry),
      file_rewritten: false,
    }
  }

  // ---- invariants on the edited set.
  const merged = [...kept, ...added]
  const lensBefore = current.filter((e) => e.kind !== 'memo').length
  const lensAfter = merged.filter((e) => e.kind !== 'memo').length
  if ((lensBefore > 0 && lensAfter === 0) || merged.length === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      `Removing ${removed.map(label).join(', ')} would leave theme "${id}" with ${lensBefore > 0 ? 'no code or category evidence' : 'no evidence at all'} — a theme has to stand on at least one. Keep one, swap in its replacement first (\`compost theme add ${id} --evidence <kind:ref>\`), or retire the theme with \`compost reject ${id}\`.`,
    )
  }
  // Frame rules live in resolveThemeEvidence, once. It is asked for the theme's
  // own frame (inferred when a pre-#266 theme has none), so the verb can never
  // flip a theme's lens. A theme created with no code/category evidence has a
  // null frame without ever having been declared cross-lens; the rule applied
  // to it is the same, only the refusal says what actually happened.
  const resolved = resolveThemeEvidence(
    seedPath,
    merged,
    frame,
    frame === null && lensBefore === 0 ? 'edit-unframed' : 'edit',
  )
  const after = resolved.evidence.map(toEntry)
  const before = Array.isArray(state.evidence) ? state.evidence : current.map(toEntry)

  // ---- write: temp file → guarded event → rename (decision 2.3).
  const staged = stageRestamp(seedPath, id, resolved.evidence)
  const discard = (): void => {
    if (staged.status === 'staged') staged.discard()
  }
  let res: ReturnType<typeof updateArtifact>
  try {
    hooks.beforeWrite?.()
    res = updateArtifact(
      seedPath,
      snap.artifact_id,
      { field: 'evidence', before, after },
      author,
      // Land only on the snapshot every check above was made against.
      { expectedParent: snap.last_event },
    )
  } catch (err) {
    discard() // the event did not land — leave the markdown untouched
    if (isCompostError(err) && err.code === 'CONFLICT') {
      throw new CompostError(
        'CONFLICT',
        `Theme "${id}" changed while this edit was being prepared — another edit, an endorse or a reject landed first. Nothing was written. Re-run \`compost theme add|remove ${id} --evidence <kind:ref>\` to apply it to the theme as it is now.`,
        { cause: err },
      )
    }
    throw err
  }
  hooks.afterEvent?.()
  const warning =
    staged.status === 'staged'
      ? landRestamp(seedPath, snap.artifact_id, id, staged, res.update_event_id)
      : staged.status === 'skipped'
        ? skippedWarning(id, staged, resolved.evidence)
        : undefined

  return {
    ...base,
    codebook_id: frame !== undefined ? frame : resolved.codebookId,
    changed: true,
    added: added.map(toEntry),
    removed: removed.map(toEntry),
    evidence: after,
    update_event_id: res.update_event_id,
    parent_event_id: res.parent_event_id,
    file_rewritten: staged.status === 'staged' && warning === undefined,
    ...(warning !== undefined ? { warning } : {}),
  }
}

/** The frame a pre-#266 theme's evidence infers, for reporting only. Null when
 * it has none or spans several (nothing is refused on a read). */
function inferredFrame(seedPath: string, evidence: ThemeEvidence[]): string | null {
  try {
    return resolveThemeEvidence(seedPath, evidence, undefined, 'edit').codebookId
  } catch (err) {
    if (!isCompostError(err)) throw err
    return null
  }
}

// ------------------------------------------------------- frontmatter restamp

type Staged =
  /** The rewritten markdown is waiting in a temp file beside the original. */
  | { status: 'staged'; path: string; rename(eventId: string): void; discard(): void }
  /** The theme has no markdown file: the event alone carries the change. */
  | { status: 'no_file' }
  /** A markdown file exists but its frontmatter could not be restamped. */
  | { status: 'skipped'; path: string }

const evidenceLine = (evidence: ThemeEvidence[]): string =>
  `evidence: ${formatYamlValue(evidence.map(encodeEvidence))}`

function skippedWarning(
  themeId: string,
  staged: { path: string },
  evidence: ThemeEvidence[],
): string {
  return `The ledger was updated, but the markdown at ${staged.path} was NOT restamped: it has no \`---\` frontmatter block (LF line endings) whose \`id:\` is ${themeId}. File readers such as \`saturate\` still see its old evidence. The ledger is canonical — set the file's frontmatter line to \`${evidenceLine(evidence)}\`.`
}

/**
 * Stage the theme markdown with its `evidence:` line (and the legacy `codes:`
 * dual-write) rewritten to `evidence`, as a temp file beside the original.
 * Nothing the readers see changes until `rename` moves it into place.
 */
function stageRestamp(seedPath: string, themeId: string, evidence: ThemeEvidence[]): Staged {
  const slug = themeId.replace(/^T-/, '')
  // The id comes from the ledger; only ever build a path from a plain slug.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return { status: 'no_file' }
  const path = join(seedPath, 'synthesis', 'themes', `${slug}.md`)
  if (!existsSync(path)) return { status: 'no_file' }
  const next = restampEvidence(readFileSync(path, 'utf8'), themeId, evidence)
  if (next === null) return { status: 'skipped', path }

  // Dot-prefixed and not `.md`, so no reader of synthesis/themes/ picks it up.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}-${Date.now()}.tmp`)
  const discard = (): void => {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort cleanup; the caller surfaces the more useful error
    }
  }
  try {
    writeFileSync(tmp, next, 'utf8')
  } catch (cause) {
    discard()
    throw new CompostError(
      'IO_ERROR',
      `Could not stage the updated markdown for ${themeId} beside ${path}. Nothing was changed — check that synthesis/themes/ is writable and retry.`,
      { cause },
    )
  }
  return {
    status: 'staged',
    path,
    discard,
    rename: (eventId) => {
      try {
        renameSync(tmp, path)
      } catch (cause) {
        discard()
        throw new CompostError(
          'IO_ERROR',
          `The evidence change to ${themeId} IS recorded in the ledger (event ${eventId}), but its markdown at ${path} could not be replaced, so file readers such as \`saturate\` still see the old set. The ledger is canonical: fix the file's permissions, then set its frontmatter line to \`${evidenceLine(evidence)}\`.`,
          { cause },
        )
      }
    },
  }
}

/**
 * Move the staged markdown into place — only now that its event has committed,
 * and under the ledger's write lock, so renames happen in event order. Without
 * the lock, an edit that commits after ours could rename first and ours would
 * then put the older set back on disk.
 *
 * Holding the lock, nothing else can commit: if our event is still the theme's
 * latest, the staged file is the current state and is renamed. If a later event
 * already landed, the staged file is stale, so the markdown is rewritten from
 * the theme's state as the ledger has it now (markdown derives from the ledger,
 * never the reverse). Returns a warning if that rewrite had to be skipped.
 */
function landRestamp(
  seedPath: string,
  artifactId: string,
  themeId: string,
  staged: Staged & { status: 'staged' },
  eventId: string,
): string | undefined {
  const events = openSeedEvents(seedPath)
  try {
    return events.transactImmediate(() => {
      // A second, read-only connection: it sees everything committed, and the
      // lock this transaction holds keeps that from changing under us.
      const now = getArtifact(seedPath, 'theme', artifactId)
      if (now === null || now.last_event === eventId) {
        staged.rename(eventId)
        return undefined
      }
      staged.discard()
      const evidence = themeEvidenceFromState(now.current_state)
      const fresh = stageRestamp(seedPath, themeId, evidence)
      if (fresh.status === 'staged') fresh.rename(now.last_event)
      return fresh.status === 'skipped' ? skippedWarning(themeId, fresh, evidence) : undefined
    })
  } catch (cause) {
    staged.discard()
    if (isCompostError(cause)) throw cause
    throw new CompostError(
      'IO_ERROR',
      `The evidence change to ${themeId} IS recorded in the ledger (event ${eventId}), but its markdown at ${staged.path} could not be updated because the ledger was busy. File readers such as \`saturate\` still see the old set; the ledger is canonical.`,
      { cause },
    )
  } finally {
    events.close()
  }
}

/**
 * Rewrite a theme markdown's frontmatter `evidence:` line — and its `codes:`
 * line, which create dual-writes only while every entry is a code — leaving
 * every other byte (other fields, the body) as it was. Null when the text has
 * no frontmatter block or its `id:` is not `themeId`.
 */
export function restampEvidence(
  text: string,
  themeId: string,
  evidence: ThemeEvidence[],
): string | null {
  if (!text.startsWith('---\n')) return null
  const close = text.indexOf('\n---', 4)
  if (close === -1) return null
  const lines = text.slice(4, close).split('\n')
  const fileId = lines
    .find((l) => /^id:/.test(l))
    ?.slice(3)
    .trim()
    .replace(/^["']|["']$/g, '')
  if (fileId !== themeId) return null

  const fresh = [evidenceLine(evidence)]
  if (evidence.every((e) => e.kind === 'code')) {
    fresh.push(`codes: ${formatYamlValue(evidence.map((e) => e.ref))}`)
  }
  const isOurs = (l: string): boolean => /^(evidence|codes):/.test(l)
  // Put the fresh lines where the first of the old ones was; a file with
  // neither gets them right after `name:` (create's field order), else last.
  let at = lines.findIndex(isOurs)
  if (at === -1) {
    const name = lines.findIndex((l) => /^name:/.test(l))
    at = name === -1 ? lines.length : name + 1
  }
  const rest = lines.filter((l) => !isOurs(l))
  const insertAt = lines.slice(0, at).filter((l) => !isOurs(l)).length
  rest.splice(insertAt, 0, ...fresh)
  return `---\n${rest.join('\n')}${text.slice(close)}`
}
