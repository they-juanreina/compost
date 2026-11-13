import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { CompostError, isCompostError } from '../errors.js'
import { formatYamlValue, updateArtifact } from './artifacts.js'
import { resolveCategory } from './categories.js'
import { resolveCodeRef, tryResolveCodeRef } from './codeRefs.js'
import type { Author } from './events.js'
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
 * - **Frames.** The edited set goes through `resolveThemeEvidence` with the
 *   theme's own frame: a single-lens theme stays in its codebook, a cross-lens
 *   theme keeps ≥2 codebooks, and the verb never flips a theme's lens.
 * - **No empty set.** A removal may not strip the last code/category; retiring
 *   a theme is `compost reject`.
 * - **Idempotent.** Adding what is present / removing what is absent changes
 *   nothing: no event, no file write.
 * - **Markdown follows the ledger.** `saturate` reads theme frontmatter, so the
 *   `evidence` line (and the legacy `codes` dual-write) is restamped atomically
 *   with the event: temp file → event → rename, temp removed if the event fails.
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
  /** The theme's frame — a CB- id, or null for cross-lens. Never changed here. */
  codebook_id: string | null
  /** Present only when `changed`. */
  update_event_id?: string
  parent_event_id?: string
  /** Whether the theme's markdown frontmatter was restamped. False on a no-op,
   * and for a theme with no markdown file (the event still carries the truth). */
  file_rewritten: boolean
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
 * `C-primary/distrust` are the same entry. A ref that no longer resolves (its
 * code/category was rejected) keys on the raw ref, so it can still be removed
 * by the ref it is stored under.
 */
function evidenceKey(seedPath: string, e: ThemeEvidence): string {
  if (e.kind === 'code') return `code:${tryResolveCodeRef(seedPath, e.ref)?.id ?? e.ref}`
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
  // even a would-be no-op — so the answer never depends on the arguments.
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
  const currentKeys = current.map((e) => evidenceKey(seedPath, e))

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

  // ---- remove: any kind; tolerant of refs that no longer resolve.
  const removeKeys = new Set<string>()
  const notPresent: ThemeEvidence[] = []
  for (const req of removes) {
    const key = evidenceKey(seedPath, req)
    if (addedKeys.has(key) || alreadyKeys.has(key)) {
      throw new CompostError(
        'INVALID_INPUT',
        `"${label(req)}" is in both the add set and the remove set — drop it from one of them.`,
      )
    }
    if (currentKeys.includes(key)) removeKeys.add(key)
    else if (!notPresent.some((e) => evidenceKey(seedPath, e) === key)) notPresent.push(req)
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
    codebook_id: frame ?? null,
  }

  // Idempotent no-op: nothing to change ⇒ no event, no write.
  if (added.length === 0 && removed.length === 0) {
    return {
      ...base,
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
  if (lensBefore > 0 && lensAfter === 0) {
    throw new CompostError(
      'INVALID_INPUT',
      `Removing ${removed.map(label).join(', ')} would leave theme "${id}" with no code or category evidence — a theme has to stand on at least one. Keep one, swap in its replacement first (\`compost theme add ${id} --evidence <kind:ref>\`), or retire the theme with \`compost reject ${id}\`.`,
    )
  }
  // Frame rules live in resolveThemeEvidence, once. It is asked for the theme's
  // own frame (inferred when a pre-#266 theme has none), so the verb can never
  // flip a theme's lens.
  const resolved = resolveThemeEvidence(seedPath, merged, frame, 'edit')
  const after = resolved.evidence.map(toEntry)
  const before = Array.isArray(state.evidence) ? state.evidence : current.map(toEntry)

  // ---- write: temp file → event → rename (decision 2.3).
  const restamp = stageFrontmatterRestamp(seedPath, id, resolved.evidence)
  let res: ReturnType<typeof updateArtifact>
  try {
    res = updateArtifact(seedPath, snap.artifact_id, { field: 'evidence', before, after }, author)
  } catch (err) {
    restamp?.discard() // the event did not land — leave the markdown untouched
    throw err
  }
  restamp?.commit(res.update_event_id)

  return {
    ...base,
    changed: true,
    added: added.map(toEntry),
    removed: removed.map(toEntry),
    evidence: after,
    update_event_id: res.update_event_id,
    parent_event_id: res.parent_event_id,
    file_rewritten: restamp !== null,
  }
}

// ------------------------------------------------------- frontmatter restamp

interface StagedRestamp {
  commit(eventId: string): void
  discard(): void
}

/**
 * Stage the theme markdown with its `evidence:` line (and the legacy `codes:`
 * dual-write) rewritten to `evidence`, as a temp file beside the original.
 * Nothing the readers see changes until `commit` renames it into place. Returns
 * null when there is nothing to restamp — no markdown file, no frontmatter, or
 * a file that belongs to a different theme; the update event still carries the
 * truth (same posture as `codebook migrate`'s frontmatter stamp).
 */
function stageFrontmatterRestamp(
  seedPath: string,
  themeId: string,
  evidence: ThemeEvidence[],
): StagedRestamp | null {
  const slug = themeId.replace(/^T-/, '')
  // The id comes from the ledger; only ever build a path from a plain slug.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null
  const path = join(seedPath, 'synthesis', 'themes', `${slug}.md`)
  if (!existsSync(path)) return null
  const next = restampEvidence(readFileSync(path, 'utf8'), themeId, evidence)
  if (next === null) return null

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
    discard,
    commit: (eventId) => {
      try {
        renameSync(tmp, path)
      } catch (cause) {
        discard()
        throw new CompostError(
          'IO_ERROR',
          `The evidence change to ${themeId} IS recorded in the ledger (event ${eventId}), but its markdown at ${path} could not be replaced, so file readers such as \`saturate\` still see the old set. The ledger is canonical: fix the file's permissions, then set its frontmatter line to \`evidence: ${formatYamlValue(evidence.map(encodeEvidence))}\`.`,
          { cause },
        )
      }
    },
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

  const fresh = [`evidence: ${formatYamlValue(evidence.map(encodeEvidence))}`]
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
