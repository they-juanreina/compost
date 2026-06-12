import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CompostError } from '../errors.js'
import { listCanonicalSessionIds } from './canonicalSessions.js'
import { codeMarkdownPaths } from './codeRefs.js'
import { resolveSeedPath, seedNameOf } from './seedResolve.js'
import { evidenceToCodeIds, loadThemeEvidence } from './themes.js'

export interface SessionWithThemes {
  id: string
  themes: string[]
}

export interface GatherOptions {
  cwd?: string
  seed?: string
  /** Scope to one codebook (CB- id): only codes in that frame count toward
   * a theme's session coverage. Saturation is frame-relative (ADR 0001) —
   * a deductive lens and an inductive lens saturate differently. Default
   * (undefined) counts every code, preserving single-codebook behavior. */
  codebookId?: string
}

/**
 * Walk a seed's coded corpus and return, per session in chronological order,
 * the themes it contributed to. The join is theme.evidence → code ids (a
 * `category` entry expands to its member codes) → code.evidence (highlight ids)
 * → highlight.session_id (#266). A theme is "from" a session if any of its
 * evidence codes is evidenced by a highlight in that session.
 *
 * Sessions are ordered by directory name (S001, S002 …) — compost's session
 * ids are assigned sequentially at ingest, so lexicographic order is also
 * chronological. The returned shape matches the input contract of
 * `saturationPulse()` in compost-retrieval.
 */
export function gatherSessionsWithThemes(opts: GatherOptions = {}): SessionWithThemes[] {
  const cwd = opts.cwd ?? process.cwd()
  const seedPath = resolveSeedPath(cwd, opts.seed)

  const highlightToSession = readHighlightSessions(join(seedPath, 'highlights'))
  const codeToHighlights = readCodeEvidence(seedPath, opts.codebookId)
  const themeToCodes = readThemeCodes(seedPath, join(seedPath, 'synthesis', 'themes'))

  const sessionToThemes = new Map<string, Set<string>>()
  // Single source of truth (#166): the same canonical-session predicate
  // `compost status` uses — `S\d+` names OR a transcript.json/source.* file.
  // Pre-fix: every subdir of sessions/ (incl. legacy Attachments/, Transcripts/)
  // was counted, inflating the session set vs status's view.
  for (const sessionId of listCanonicalSessionIds(join(seedPath, 'sessions'))) {
    sessionToThemes.set(sessionId, new Set())
  }

  for (const [themeId, codeIds] of themeToCodes) {
    for (const codeId of codeIds) {
      const highlightIds = codeToHighlights.get(codeId) ?? []
      for (const hid of highlightIds) {
        const sessionId = highlightToSession.get(hid)
        if (sessionId === undefined) continue
        const bucket = sessionToThemes.get(sessionId)
        if (bucket === undefined) {
          // Highlight references a session that isn't a directory under
          // sessions/ — surface it so a broken corpus fails loudly rather
          // than silently distorting the saturation curve.
          throw new CompostError(
            'SCHEMA_VIOLATION',
            `Highlight ${hid} references session ${sessionId}, but Seeds/${seedNameOf(seedPath)}/sessions/${sessionId}/ does not exist.`,
          )
        }
        bucket.add(themeId)
      }
    }
  }

  return [...sessionToThemes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, themes]) => ({ id, themes: [...themes].sort() }))
}

function readHighlightSessions(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const fm of readFrontmatters(dir)) {
    const id = fm.scalars.get('id')
    const sessionId = fm.scalars.get('session_id')
    if (id !== undefined && sessionId !== undefined) out.set(id, sessionId)
  }
  return out
}

function readCodeEvidence(seedPath: string, codebookId?: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  // Walk both code layouts (#269): legacy flat + namespaced codebook/<cb>/.
  for (const path of codeMarkdownPaths(seedPath)) {
    const fm = parseFrontmatter(readFileSync(path, 'utf8'))
    if (fm === null) continue
    const id = fm.scalars.get('id')
    const evidence = fm.arrays.get('evidence')
    // Scope to one frame when asked: a code's codebook_id (default CB-primary
    // for pre-codebook codes) must match. Drop codes outside the frame so they
    // contribute no session coverage.
    if (codebookId !== undefined) {
      const codeFrame = fm.scalars.get('codebook_id') ?? 'CB-primary'
      if (codeFrame !== codebookId) continue
    }
    if (id !== undefined && evidence !== undefined) out.set(id, evidence)
  }
  return out
}

/**
 * Theme → contributing code ids, evidence-kind-aware (#266). A theme's support
 * is now a heterogeneous `evidence[{kind: code|category}]` set: a `code` entry
 * resolves to itself, a `category` entry expands to its member codes via
 * `link(code → category)` events. Legacy `codes[]`-only themes are lazy-mapped
 * to `evidence` (kind=code) so the deprecation window is transparent here.
 */
function readThemeCodes(seedPath: string, dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const fm of readFrontmatters(dir)) {
    const id = fm.scalars.get('id')
    if (id === undefined) continue
    const evidenceTokens = fm.arrays.get('evidence')
    const codeTokens = fm.arrays.get('codes')
    const evidence = loadThemeEvidence({
      ...(evidenceTokens !== undefined ? { evidence: evidenceTokens } : {}),
      ...(codeTokens !== undefined ? { codes: codeTokens } : {}),
    })
    if (evidence.length === 0) continue
    out.set(id, evidenceToCodeIds(seedPath, evidence))
  }
  return out
}

interface Frontmatter {
  scalars: Map<string, string>
  arrays: Map<string, string[]>
}

function readFrontmatters(dir: string): Frontmatter[] {
  if (!existsSync(dir)) return []
  const out: Frontmatter[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const path = resolve(dir, entry)
    if (!statSync(path).isFile()) continue
    const fm = parseFrontmatter(readFileSync(path, 'utf8'))
    if (fm !== null) out.push(fm)
  }
  return out
}

function parseFrontmatter(content: string): Frontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (match === null) return null
  const scalars = new Map<string, string>()
  const arrays = new Map<string, string[]>()
  for (const line of (match[1] ?? '').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (m === null) continue
    const key = m[1]
    const raw = (m[2] ?? '').trim()
    if (key === undefined || raw.length === 0) continue
    const inline = raw.match(/^\[(.*)\]$/)
    if (inline !== null) {
      arrays.set(
        key,
        (inline[1] ?? '')
          .split(',')
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0),
      )
    } else {
      scalars.set(key, stripQuotes(raw))
    }
  }
  return { scalars, arrays }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}
