import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CompostError } from '../errors.js'
import {
  CODEBOOK_STANCES,
  type CodebookStance,
  createCode,
  createCodebook,
  DEFAULT_CODEBOOK_ID,
  ensurePrimaryCodebook,
  rejectArtifact,
  resolveCodebookId,
  updateArtifact,
} from './artifacts.js'
import { listCategoryLinks } from './categories.js'
import {
  codebookSlugOf,
  codeMarkdownPaths,
  parseCodeId,
  qualifiedCodeId,
  tryResolveCodeRef,
} from './codeRefs.js'
import { listArtifacts, type SnapshotView } from './reads.js'

/** Current snapshots of the seed's codebooks, newest activity first. */
export function listCodebooks(seedPath: string): SnapshotView[] {
  return listArtifacts(seedPath, 'codebook')
}

export interface CodebookMigrationPlan {
  /** True when `codebooks/primary.md` does not exist yet. */
  needs_primary: boolean
  /** Event-backed codes (current, non-archived) whose state carries no
   * codebook_id — stamped with an update event + frontmatter rewrite. */
  codes: Array<{
    /** Ref usable with updateArtifact: human id when the code has one, else the SHA. */
    ref: string
    artifact_id: string
    /** Seed-relative markdown path, when the code has a file (scanner drafts don't). */
    file?: string
  }>
  /** codebook/*.md files with no create event (sample fixture, hand-authored,
   * imported) and no codebook_id — covered by the lazy-read default, so
   * migration only rewrites their frontmatter (there is no provenance record to
   * emit an update against). Surfaced rather than silently skipped. */
  file_only: string[]
}

/** Pull `id` / `codebook_id` / presence-of-codebook_id out of a code
 * markdown's frontmatter. */
function readCodeFrontmatter(text: string): {
  id?: string
  codebook_id?: string
  hasCodebookId: boolean
} {
  if (!text.startsWith('---\n')) return { hasCodebookId: false }
  const close = text.indexOf('\n---', 4)
  const block = close === -1 ? text : text.slice(4, close)
  const id = /^id:\s*(\S+)/m.exec(block)?.[1]
  const codebook_id = /^codebook_id:\s*(\S+)/m.exec(block)?.[1]
  return {
    ...(id !== undefined ? { id } : {}),
    ...(codebook_id !== undefined ? { codebook_id } : {}),
    hasCodebookId: codebook_id !== undefined,
  }
}

// ---------------------------------------------------------------- id qualification (#269)

export interface CodeIdMigrationPlan {
  /** Codes whose id is not yet the namespaced `C-<cb-slug>/<code-slug>` form
   * and/or whose file is not under `codebook/<cb-slug>/`. */
  codes: Array<{ old_id: string; new_id: string; old_path: string; new_path: string }>
  /** Codes already in the namespaced form — left untouched. */
  already_qualified: number
  /** Targets that would overwrite an existing un-migrated file, or that two
   * codes map to — the migration refuses rather than clobber (#269 review). */
  conflicts: Array<{ new_id: string; new_path: string }>
}

/**
 * Dry-run for `compost codebook migrate-ids` (#269, Option A): which codes
 * would move from a bare `C-<slug>` (flat `codebook/<slug>.md`) to the
 * namespaced `C-<cb-slug>/<code-slug>` (`codebook/<cb-slug>/<code-slug>.md`).
 * The frame is the code's `codebook_id` (default primary). Idempotent: a code
 * already in the namespaced form is counted, not re-listed.
 */
export function planCodeIdMigration(seedPath: string): CodeIdMigrationPlan {
  const codebookDir = join(seedPath, 'codebook')
  const codes: CodeIdMigrationPlan['codes'] = []
  let already = 0
  for (const path of codeMarkdownPaths(seedPath)) {
    const fm = readCodeFrontmatter(readFileSync(path, 'utf8'))
    if (fm.id === undefined) continue
    const cbId = fm.codebook_id ?? DEFAULT_CODEBOOK_ID
    const codeSlug = parseCodeId(fm.id).codeSlug
    const newId = qualifiedCodeId(cbId, codeSlug)
    const newPath = join(codebookDir, codebookSlugOf(cbId), `${codeSlug}.md`)
    if (fm.id === newId && resolve(path) === resolve(newPath)) {
      already += 1
      continue
    }
    codes.push({ old_id: fm.id, new_id: newId, old_path: path, new_path: newPath })
  }

  // Collision guard: a target that already exists as an un-migrated file, or
  // that two codes map to, would silently overwrite/destroy data on --apply.
  const targetCount = new Map<string, number>()
  for (const c of codes)
    targetCount.set(resolve(c.new_path), (targetCount.get(resolve(c.new_path)) ?? 0) + 1)
  const movingFrom = new Set(codes.map((c) => resolve(c.old_path)))
  const conflicts: CodeIdMigrationPlan['conflicts'] = []
  for (const c of codes) {
    const np = resolve(c.new_path)
    const dupTarget = (targetCount.get(np) ?? 0) > 1
    const overwrites = existsSync(c.new_path) && np !== resolve(c.old_path) && !movingFrom.has(np)
    if (dupTarget || overwrites) conflicts.push({ new_id: c.new_id, new_path: c.new_path })
  }

  return { codes, already_qualified: already, conflicts }
}

export interface CodeIdMigrationResult {
  migrated: Array<{ old_id: string; new_id: string; event_emitted: boolean }>
}

/**
 * Apply the id qualification: per code, record the id change as an
 * `update{field:id}` event (the human id is a mutable label; the artifact_id /
 * SHA is the stable identity, so blame lineage is preserved), then rewrite the
 * file's `id:` frontmatter and move it to the namespaced path. A file-only code
 * (sample fixture / hand-authored / imported — no create event) gets the file
 * rewrite only; there is no create event to chain an update onto.
 */
export function applyCodeIdMigration(
  seedPath: string,
  researcherId: string,
): CodeIdMigrationResult {
  const plan = planCodeIdMigration(seedPath)
  if (plan.conflicts.length > 0) {
    // Refuse before touching anything — overwriting/destroying a code is never
    // the right migration outcome; the researcher resolves the duplicate first.
    throw new CompostError(
      'INVALID_INPUT',
      `Refusing migrate-ids: ${plan.conflicts.length} target(s) would overwrite an existing code — ${plan.conflicts
        .map((c) => `${c.new_id} (${c.new_path})`)
        .join(', ')}. Resolve the duplicate code names first.`,
    )
  }

  const author = { actorType: 'researcher' as const, actorId: researcherId }
  // Emit a rename event ONLY for a code that has its OWN create event (exact id
  // match) — never via updateArtifact's bare-shorthand resolution, which would
  // fan out to an unrelated same-slug namespaced code and corrupt it (#269
  // review). A file-only code (no create event) gets the file rewrite only.
  const eventBackedIds = new Set(
    listArtifacts(seedPath, 'code')
      .map((s) => (s.current_state as { id?: string }).id)
      .filter((id): id is string => typeof id === 'string'),
  )

  const migrated: CodeIdMigrationResult['migrated'] = []
  for (const c of plan.codes) {
    let event_emitted = false
    if (eventBackedIds.has(c.old_id)) {
      updateArtifact(seedPath, c.old_id, { field: 'id', before: c.old_id, after: c.new_id }, author)
      event_emitted = true
    }
    const content = readFileSync(c.old_path, 'utf8').replace(/^id:.*$/m, `id: ${c.new_id}`)
    mkdirSync(dirname(c.new_path), { recursive: true })
    writeFileSync(c.new_path, content, 'utf8')
    if (resolve(c.new_path) !== resolve(c.old_path)) rmSync(c.old_path, { force: true })
    migrated.push({ old_id: c.old_id, new_id: c.new_id, event_emitted })
  }
  return { migrated }
}

/**
 * Dry-run for `compost codebook migrate`: which codes would be stamped with
 * the primary codebook_id. Reads are lazy-tolerant already (missing
 * codebook_id ⇒ primary), so applying is about making the events + frontmatter
 * say what readers assume.
 */
export function planCodebookMigration(seedPath: string): CodebookMigrationPlan {
  const codes: CodebookMigrationPlan['codes'] = []
  const eventBackedFiles = new Set<string>()
  // includeArchived so a rejected code's lingering codebook/<slug>.md (reject
  // archives, never deletes) is recorded here and thus excluded from the
  // file-only orphan scan below — otherwise migration would re-stamp a
  // deliberately-rejected code's frontmatter and falsely report it migrated.
  for (const snap of listArtifacts(seedPath, 'code', { includeArchived: true })) {
    const state = snap.current_state as { id?: string; codebook_id?: string }
    const humanId = typeof state.id === 'string' ? state.id : undefined
    // C-<slug> → codebook/<slug>.md; event-only drafts have no file.
    const file = humanId?.startsWith('C-') ? join('codebook', `${humanId.slice(2)}.md`) : undefined
    if (file !== undefined) eventBackedFiles.add(file)
    if (snap.archived) continue // never emit a resurrecting update on a rejected code
    if (state.codebook_id !== undefined) continue
    codes.push({
      ref: humanId ?? snap.artifact_id,
      artifact_id: snap.artifact_id,
      ...(file !== undefined ? { file } : {}),
    })
  }

  // File-only codes: a .md under codebook/ with no event behind it and no
  // codebook_id yet. The sample fixture and imported codebooks look like this.
  const file_only: string[] = []
  const codebookDir = join(seedPath, 'codebook')
  if (existsSync(codebookDir)) {
    for (const entry of readdirSync(codebookDir)) {
      if (!entry.endsWith('.md')) continue
      const rel = join('codebook', entry)
      if (eventBackedFiles.has(rel)) continue
      const fm = readCodeFrontmatter(readFileSync(join(codebookDir, entry), 'utf8'))
      if (!fm.hasCodebookId) file_only.push(rel)
    }
  }

  return {
    needs_primary: !existsSync(join(seedPath, 'codebooks', 'primary.md')),
    codes,
    file_only,
  }
}

export interface CodebookMigrationResult {
  primary_created: boolean
  updated: Array<{ ref: string; update_event_id: string; file_rewritten: boolean }>
  /** File-only codes whose frontmatter was stamped (no event emitted — they
   * have no create event to chain an update to). */
  file_only_stamped: string[]
}

/**
 * Apply the migration: ensure the primary codebook exists, then per event-backed
 * code emit one researcher update event `{field: codebook_id, before: null,
 * after: CB-primary}` and add the field to the code's frontmatter (markdown is
 * canonical; the event records the change). Append-only — nothing is edited in
 * the log. File-only codes get a frontmatter stamp only (no provenance record
 * to update); they already read as CB-primary via the lazy default.
 */
export function applyCodebookMigration(
  seedPath: string,
  researcherId: string,
): CodebookMigrationResult {
  const plan = planCodebookMigration(seedPath)
  const primary = ensurePrimaryCodebook(seedPath)
  const author = { actorType: 'researcher' as const, actorId: researcherId }

  const updated: CodebookMigrationResult['updated'] = []
  for (const code of plan.codes) {
    const res = updateArtifact(
      seedPath,
      code.ref,
      { field: 'codebook_id', before: null, after: DEFAULT_CODEBOOK_ID },
      author,
    )
    let fileRewritten = false
    if (code.file !== undefined) {
      fileRewritten = addFrontmatterField(
        join(seedPath, code.file),
        'codebook_id',
        DEFAULT_CODEBOOK_ID,
      )
    }
    updated.push({
      ref: code.ref,
      update_event_id: res.update_event_id,
      file_rewritten: fileRewritten,
    })
  }

  const file_only_stamped: string[] = []
  for (const rel of plan.file_only) {
    if (addFrontmatterField(join(seedPath, rel), 'codebook_id', DEFAULT_CODEBOOK_ID)) {
      file_only_stamped.push(rel)
    }
  }

  return { primary_created: primary.created, updated, file_only_stamped }
}

/**
 * Insert `key: value` into a markdown file's frontmatter block iff the key is
 * absent. Returns whether the file was rewritten. No-op (false) when the file
 * is missing or has no frontmatter — the update event still carries the truth.
 */
function addFrontmatterField(absPath: string, key: string, value: string): boolean {
  if (!existsSync(absPath)) return false
  const text = readFileSync(absPath, 'utf8')
  if (!text.startsWith('---\n')) return false
  const close = text.indexOf('\n---', 4)
  if (close === -1) return false
  const block = text.slice(4, close)
  if (new RegExp(`^${key}:`, 'm').test(block)) return false
  const rewritten = `---\n${block}\n${key}: ${value}${text.slice(close)}`
  writeFileSync(absPath, rewritten, 'utf8')
  return true
}

// ---------------------------------------------------------------- duplicate (#269)

const RESEARCHER = (researcherId: string) =>
  ({ actorType: 'researcher', actorId: researcherId }) as const

/** A sibling seed path under the same `Seeds/` root, validated. Rejects names
 * carrying a path separator so `--from ../escape` can't reach outside the
 * workspace. */
function siblingSeedPath(seedPath: string, seedName: string): string {
  if (/[/\\]/.test(seedName) || seedName === '.' || seedName === '..') {
    throw new CompostError(
      'INVALID_INPUT',
      `Invalid --from seed ${JSON.stringify(seedName)}: expected a plain seed name (a directory under Seeds/).`,
    )
  }
  const path = join(dirname(seedPath), seedName)
  if (!existsSync(join(path, '.compost', 'events.sqlite'))) {
    throw new CompostError(
      'FILE_NOT_FOUND',
      `No seed "${seedName}" with an event log alongside this one (looked in ${dirname(seedPath)}). --from names a sibling seed under the same Seeds/.`,
    )
  }
  return path
}

/** Declared stance + description of a codebook. CB-primary is the implicit
 * inductive default and has no artifact to read. */
function codebookMeta(
  seedPath: string,
  codebookId: string,
): { stance: CodebookStance; description: string } {
  if (codebookId === DEFAULT_CODEBOOK_ID) return { stance: 'inductive', description: '' }
  for (const snap of listCodebooks(seedPath)) {
    const s = snap.current_state as { id?: string; stance?: string; description?: string }
    if (s.id === codebookId) {
      const stance = CODEBOOK_STANCES.includes(s.stance as CodebookStance)
        ? (s.stance as CodebookStance)
        : 'inductive'
      return { stance, description: s.description ?? '' }
    }
  }
  return { stance: 'inductive', description: '' }
}

interface FrameCode {
  id: string
  name: string
  definition: string
}

/** Non-archived codes belonging to one frame of a seed, with their definitions.
 * The lazy default (missing codebook_id ⇒ primary) keeps legacy codes visible. */
function codesInCodebook(seedPath: string, codebookId: string): FrameCode[] {
  const out: FrameCode[] = []
  for (const snap of listArtifacts(seedPath, 'code')) {
    const s = snap.current_state as {
      id?: string
      name?: string
      definition?: string
      codebook_id?: string
    }
    if (typeof s.id !== 'string' || typeof s.name !== 'string') continue
    if ((s.codebook_id ?? DEFAULT_CODEBOOK_ID) !== codebookId) continue
    out.push({ id: s.id, name: s.name, definition: s.definition ?? '' })
  }
  return out
}

export interface DuplicateOptions {
  /** Read `<source>` from a sibling seed under the same `Seeds/` root instead of
   * locally — the cross-study framework-reuse case (the old `import`). Copied
   * codes carry a `<seed>:<id>` lineage ref; evidence never travels. */
  fromSeed?: string
}

export interface DuplicateResult {
  source_seed: string
  source_codebook_id: string
  stance: CodebookStance
  /** The new frame. */
  codebook_id: string
  codebook_artifact_id: string
  /** Cloned codes: origin id → new id. */
  codes: Array<{ from: string; to: string }>
}

/**
 * `compost codebook duplicate` (#269, ADR 0001) — copy a codebook as a new,
 * independent lens. Definitions + a `derived_from` lineage link travel; **coded
 * instances (evidence) do not** — the copy enters un-grounded and earns its
 * grounding by being coded against the local data (framework/deductive coding,
 * Ritchie & Spencer). Category links are not copied (a duplicate is a fresh
 * second pass). Same-seed (a parallel lens) and cross-seed (`--from`, reuse a
 * validated frame from another study) are the same operation; only where the
 * source is read differs. Refuses an in_vivo source — participant-verbatim names
 * can't be re-homed without their evidence (#268).
 *
 * Born researcher-authored (a lens is structural setup, like `codebook new`),
 * not an AI [draft]: the human chose to bring this frame in. Additive — it
 * touches nothing existing, so it is not dry-run-gated; the target codebook must
 * not already exist (clean reject, never overwrite).
 */
export function duplicateCodebook(
  seedPath: string,
  sourceRef: string,
  newName: string,
  researcherId: string,
  opts: DuplicateOptions = {},
): DuplicateResult {
  const sourceSeedPath =
    opts.fromSeed !== undefined ? siblingSeedPath(seedPath, opts.fromSeed) : seedPath
  const sourceSeed = opts.fromSeed ?? basename(seedPath)

  // Resolve + read the source frame within ITS OWN seed.
  const sourceCbId = resolveCodebookId(sourceSeedPath, sourceRef)
  const { stance, description } = codebookMeta(sourceSeedPath, sourceCbId)

  if (stance === 'in_vivo') {
    throw new CompostError(
      'INVALID_INPUT',
      `Cannot duplicate in_vivo codebook "${sourceCbId}": in_vivo code names are participant-verbatim and only hold against their own evidence, which does not travel with a duplicate. Code a fresh in_vivo lens against the local data instead.`,
    )
  }

  // Read every source code BEFORE writing anything, so the only failure during
  // the write phase would be an unexpected I/O error, never a predictable one.
  const sourceCodes = codesInCodebook(sourceSeedPath, sourceCbId)

  // createCodebook rejects (never overwrites) when the target already exists.
  const author = RESEARCHER(researcherId)
  const created = createCodebook(seedPath, {
    name: newName,
    stance,
    ...(description !== '' ? { description } : {}),
    author,
  })

  const codes: DuplicateResult['codes'] = []
  for (const code of sourceCodes) {
    const copy = createCode(seedPath, {
      name: code.name,
      definition: code.definition,
      codebookId: created.id,
      derivedFrom: opts.fromSeed !== undefined ? `${sourceSeed}:${code.id}` : code.id,
      author,
    })
    codes.push({ from: code.id, to: copy.id })
  }

  return {
    source_seed: sourceSeed,
    source_codebook_id: sourceCbId,
    stance,
    codebook_id: created.id,
    codebook_artifact_id: created.artifact_id,
    codes,
  }
}

// ---------------------------------------------------------------- merge (#269)

/** A codebook id that resolves AND is not archived (rejected). resolveCodebookId
 * happily resolves a rejected frame's id from its create event; merge needs the
 * frame to be live on both ends. */
function isLiveCodebook(seedPath: string, codebookId: string): boolean {
  if (codebookId === DEFAULT_CODEBOOK_ID) return true
  return listCodebooks(seedPath).some((s) => (s.current_state as { id?: string }).id === codebookId)
}

/** A within-frame-unique code slug: the source slug if free, else
 * `<slug>-from-<fromSlug>`, else a numeric suffix. Mutates `taken`. */
function disambiguateSlug(slugName: string, fromSlug: string, taken: Set<string>): string {
  if (!taken.has(slugName)) {
    taken.add(slugName)
    return slugName
  }
  let candidate = `${slugName}-from-${fromSlug}`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${slugName}-from-${fromSlug}-${n}`
    n += 1
  }
  taken.add(candidate)
  return candidate
}

/** The existing on-disk path of a code, across both layouts (#269): namespaced
 * `codebook/<cb>/<slug>.md` or legacy flat `codebook/<slug>.md`. */
function existingCodePath(seedPath: string, fromSlug: string, codeSlug: string): string | null {
  const namespaced = join(seedPath, 'codebook', fromSlug, `${codeSlug}.md`)
  if (existsSync(namespaced)) return namespaced
  const flat = join(seedPath, 'codebook', `${codeSlug}.md`)
  if (existsSync(flat)) return flat
  return null
}

/** Rewrite a re-homed code's frontmatter (id, codebook_id, and name when the
 * slug was disambiguated) and move it to the target frame's dir. The SHA
 * `artifact_id` is NOT touched — re-homing is an update, so identity is stable. */
function rehomeCodeFile(
  oldPath: string,
  newPath: string,
  newId: string,
  intoId: string,
  newName: string | undefined,
): void {
  let content = readFileSync(oldPath, 'utf8')
    .replace(/^id:.*$/m, `id: ${newId}`)
    .replace(/^codebook_id:.*$/m, `codebook_id: ${intoId}`)
  if (newName !== undefined) content = content.replace(/^name:.*$/m, `name: ${newName}`)
  mkdirSync(dirname(newPath), { recursive: true })
  writeFileSync(newPath, content, 'utf8')
  if (resolve(newPath) !== resolve(oldPath)) rmSync(oldPath, { force: true })
}

export interface MergePlan {
  from: string
  into: string
  /** Codes that would re-home, origin id → new id (renamed on a within-frame
   * collision). */
  codes: Array<{ from_id: string; to_id: string; renamed: boolean }>
  /** Higher-tier artifacts that reference a re-homing code and would dangle or
   * change meaning — merge refuses until the researcher resolves them. */
  blocking: {
    /** Theme ids citing a code in the source frame (re-homing could turn a
     * cross-lens theme single-lens — a meaning change merge must not make
     * silently). */
    themes: string[]
    /** code → category links into the source frame (re-homing would dangle the
     * ref and break the one-frame-per-category invariant). */
    category_links: Array<{ code: string; category: string }>
  }
}

/** Resolve + validate both ends of a merge and compute the re-home plan,
 * read-only. Shared by the dry-run and the apply. */
export function planMerge(seedPath: string, fromRef: string, intoRef: string): MergePlan {
  const fromId = resolveCodebookId(seedPath, fromRef)
  const intoId = resolveCodebookId(seedPath, intoRef)

  if (fromId === intoId) {
    throw new CompostError('INVALID_INPUT', `Cannot merge "${fromId}" into itself.`)
  }
  if (fromId === DEFAULT_CODEBOOK_ID) {
    throw new CompostError(
      'INVALID_INPUT',
      'Cannot merge the primary frame away — it is the structural default every code falls back to. Merge other lenses into primary instead.',
    )
  }
  if (!isLiveCodebook(seedPath, fromId)) {
    throw new CompostError('INVALID_INPUT', `Source codebook "${fromId}" is archived or unknown.`)
  }
  if (!isLiveCodebook(seedPath, intoId)) {
    throw new CompostError('INVALID_INPUT', `Target codebook "${intoId}" is archived or unknown.`)
  }

  const fromSlug = codebookSlugOf(fromId)

  // Slugs already taken in the target frame seed the collision check.
  const taken = new Set(codesInCodebook(seedPath, intoId).map((c) => parseCodeId(c.id).codeSlug))

  const codes: MergePlan['codes'] = []
  for (const code of codesInCodebook(seedPath, fromId)) {
    const codeSlug = parseCodeId(code.id).codeSlug
    const targetSlug = disambiguateSlug(codeSlug, fromSlug, taken)
    codes.push({
      from_id: code.id,
      to_id: qualifiedCodeId(intoId, targetSlug),
      renamed: targetSlug !== codeSlug,
    })
  }

  // Reference guard: a re-homing code woven into a theme or category cannot be
  // moved without dangling the ref or changing the theme's lens membership.
  // Refuse (transactionally) and tell the researcher to resolve those first —
  // auto-rewiring would silently re-decide cross-lens/one-frame invariants.
  const themes: string[] = []
  for (const snap of listArtifacts(seedPath, 'theme')) {
    const s = snap.current_state as {
      id?: string
      evidence?: Array<{ kind?: string; codebook_id?: string }>
    }
    const citesFrom = (s.evidence ?? []).some((e) => e.kind === 'code' && e.codebook_id === fromId)
    if (citesFrom && typeof s.id === 'string') themes.push(s.id)
  }

  const category_links: MergePlan['blocking']['category_links'] = []
  for (const link of listCategoryLinks(seedPath)) {
    const resolved = tryResolveCodeRef(seedPath, link.code)
    if (resolved?.codebookId === fromId) {
      category_links.push({ code: link.code, category: link.category })
    }
  }

  return { from: fromId, into: intoId, codes, blocking: { themes, category_links } }
}

export interface MergeResult {
  from: string
  into: string
  codes: Array<{ from_id: string; to_id: string; renamed: boolean }>
  archived_from: boolean
}

/**
 * `compost codebook merge <from> <into>` (#269, ADR 0001) — fold one lens into
 * another. Each of `<from>`'s codes is **re-homed** (an `update(codebook_id)` +
 * `update(id)`, preserving the SHA identity and history, so its existing local
 * evidence stays attached), then `<from>` is **reject-archived** (never deleted —
 * `reject` archives, ADR 0001). Colliding names are **kept distinct**, never
 * silently fused: an incoming `distrust` that clashes with the target's becomes
 * `distrust-from-<fromframe>`, recorded via an `update(name)` event so `blame`
 * shows the rename. Coverage math (`saturate`/`agreement`) then sees the two as
 * distinct until the researcher explicitly de-dups.
 *
 * Consequential (file moves + archive), so it is dry-run-first: callers preview
 * with {@link planMerge} and only `applyMerge` writes. Refuses when a re-homing
 * code is cited by a theme or category link (those carry cross-lens / one-frame
 * invariants merge must not silently re-decide — see MergePlan.blocking).
 */
export function applyMerge(
  seedPath: string,
  fromRef: string,
  intoRef: string,
  researcherId: string,
): MergeResult {
  const plan = planMerge(seedPath, fromRef, intoRef)

  if (plan.blocking.themes.length > 0 || plan.blocking.category_links.length > 0) {
    const bits: string[] = []
    if (plan.blocking.themes.length > 0) bits.push(`themes ${plan.blocking.themes.join(', ')}`)
    if (plan.blocking.category_links.length > 0) {
      bits.push(
        `category links ${plan.blocking.category_links.map((l) => `${l.code}→${l.category}`).join(', ')}`,
      )
    }
    throw new CompostError(
      'INVALID_INPUT',
      `Refusing merge: codes in "${plan.from}" are woven into higher tiers (${bits.join('; ')}). Re-cite or drop those first — merge re-homes codes and will not silently change a theme's lens membership or a category's frame.`,
    )
  }

  const author = RESEARCHER(researcherId)
  const fromSlug = codebookSlugOf(plan.from)
  const intoSlug = codebookSlugOf(plan.into)

  for (const code of plan.codes) {
    const oldName = parseCodeId(code.from_id).codeSlug
    const newSlug = parseCodeId(code.to_id).codeSlug
    // Re-home: codebook_id then id (chained updates on the same artifact). The
    // SHA identity is unchanged, so history + attached evidence carry over.
    updateArtifact(
      seedPath,
      code.from_id,
      { field: 'codebook_id', before: plan.from, after: plan.into },
      author,
    )
    updateArtifact(
      seedPath,
      code.from_id,
      { field: 'id', before: code.from_id, after: code.to_id },
      author,
    )
    if (code.renamed) {
      updateArtifact(
        seedPath,
        code.to_id,
        { field: 'name', before: oldName, after: newSlug },
        author,
      )
    }
    const oldPath = existingCodePath(seedPath, fromSlug, oldName)
    if (oldPath !== null) {
      const newPath = join(seedPath, 'codebook', intoSlug, `${newSlug}.md`)
      rehomeCodeFile(oldPath, newPath, code.to_id, plan.into, code.renamed ? newSlug : undefined)
    }
  }

  // Reject-archive the now-empty source frame (never delete — ADR 0001).
  const reject = rejectArtifact(
    seedPath,
    plan.from,
    researcherId,
    `Merged into ${plan.into} (${plan.codes.length} code(s) re-homed).`,
  )

  return {
    from: plan.from,
    into: plan.into,
    codes: plan.codes,
    archived_from: reject.already_rejected !== true,
  }
}
