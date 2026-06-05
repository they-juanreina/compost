import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { CompostError } from '../errors.js'
import { listCanonicalSessionIds } from './canonicalSessions.js'
import { resolveSeedPath } from './seedResolve.js'

export interface SessionWithThemes {
  id: string
  themes: string[]
}

export interface GatherOptions {
  cwd?: string
  seed?: string
}

/**
 * Walk a seed's coded corpus and return, per session in chronological order,
 * the themes it contributed to. The join is theme.codes → code.evidence
 * (highlight ids) → highlight.session_id. A theme is "from" a session if any
 * of its codes is evidenced by a highlight in that session.
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
  const codeToHighlights = readCodeEvidence(join(seedPath, 'codebook'))
  const themeToCodes = readThemeCodes(join(seedPath, 'synthesis', 'themes'))

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
            `Highlight ${hid} references session ${sessionId}, but Seeds/${basename(seedPath)}/sessions/${sessionId}/ does not exist.`,
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

function readCodeEvidence(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const fm of readFrontmatters(dir)) {
    const id = fm.scalars.get('id')
    const evidence = fm.arrays.get('evidence')
    if (id !== undefined && evidence !== undefined) out.set(id, evidence)
  }
  return out
}

function readThemeCodes(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const fm of readFrontmatters(dir)) {
    const id = fm.scalars.get('id')
    const codes = fm.arrays.get('codes')
    if (id !== undefined && codes !== undefined) out.set(id, codes)
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
