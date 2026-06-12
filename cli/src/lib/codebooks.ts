import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { CompostError } from '../errors.js'
import { DEFAULT_CODEBOOK_ID, ensurePrimaryCodebook, updateArtifact } from './artifacts.js'
import { codebookSlugOf, codeMarkdownPaths, parseCodeId, qualifiedCodeId } from './codeRefs.js'
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
