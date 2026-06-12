import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ChunkMetadataPatch,
  chunkIdFor,
  type LanceDBWriter,
} from '@they-juanreina/compost-retrieval'

import { DEFAULT_CODEBOOK_ID } from '../lib/artifacts.js'

/**
 * Chunk-metadata backfill (#275). `upsertByTextSha` is add-only, so codes
 * created or linked AFTER the ingest-time embed pass never reach chunk
 * metadata. This recomputes, from current code evidence, which first-cycle
 * codes (and which codebook frames) cover each utterance, and patches the
 * `utterance` + `highlight` chunks that utterance produced — addressed by the
 * same deterministic `chunkIdFor` the chunker uses. Missing chunk ids (e.g. a
 * highlight chunk that never existed because the highlight post-dates ingest)
 * are no-ops in `updateChunkMetadata`.
 *
 * The set is REPLACED each pass (not unioned), so an `unlink` or a deleted code
 * shrinks coverage rather than leaving stale ids. Both the embed-worker pass
 * (auto) and `reindex --vectors` (backstop) call this.
 */

// Only utterance + highlight chunks inherit a coded utterance's codes (the
// maintainer decision); window/page/term chunks are context aggregates.
const BACKFILLED_CHUNK_TYPES = ['utterance', 'highlight'] as const

interface CodeRow {
  id: string
  codebookId: string
  evidence: string[]
}

/** Minimal frontmatter read: a scalar by key, or an inline `[a, b]` array. */
function readFrontmatter(text: string): {
  scalar: (k: string) => string | undefined
  array: (k: string) => string[]
} {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const block = m?.[1] ?? ''
  return {
    scalar(key: string) {
      const line = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
      const raw = line?.[1]?.trim()
      if (raw === undefined || raw.startsWith('[')) return undefined
      return stripQuotes(raw)
    },
    array(key: string) {
      const line = block.match(new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm'))
      if (line?.[1] === undefined) return []
      return line[1]
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0)
    },
  }
}

function stripQuotes(s: string): string {
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s
}

function readCodes(seedPath: string): CodeRow[] {
  const dir = join(seedPath, 'codebook')
  if (!existsSync(dir)) return []
  const out: CodeRow[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const fm = readFrontmatter(readFileSync(join(dir, entry), 'utf8'))
    const id = fm.scalar('id')
    if (id === undefined) continue
    out.push({
      id,
      codebookId: fm.scalar('codebook_id') ?? DEFAULT_CODEBOOK_ID,
      evidence: fm.array('evidence'),
    })
  }
  return out
}

/** highlight id → "<session_id>/<utterance_id>". */
function readHighlightUtterances(seedPath: string): Map<string, string> {
  const dir = join(seedPath, 'highlights')
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const fm = readFrontmatter(readFileSync(join(dir, entry), 'utf8'))
    const id = fm.scalar('id')
    const session = fm.scalar('session_id')
    const utterance = fm.scalar('utterance_id')
    if (id !== undefined && session !== undefined && utterance !== undefined) {
      out.set(id, `${session}/${utterance}`)
    }
  }
  return out
}

/** "<session_id>/<utterance_id>" → utterance text, from every transcript.json. */
function readUtteranceText(seedPath: string): Map<string, string> {
  const sessionsDir = join(seedPath, 'sessions')
  const out = new Map<string, string>()
  if (!existsSync(sessionsDir)) return out
  for (const entry of readdirSync(sessionsDir)) {
    const tp = join(sessionsDir, entry, 'transcript.json')
    if (!existsSync(tp)) continue
    let doc: { session_id?: string; utterances?: Array<{ id?: string; text?: string }> }
    try {
      doc = JSON.parse(readFileSync(tp, 'utf8'))
    } catch {
      continue
    }
    const session = doc.session_id ?? entry
    for (const u of doc.utterances ?? []) {
      if (typeof u.id === 'string' && typeof u.text === 'string') {
        out.set(`${session}/${u.id}`, u.text)
      }
    }
  }
  return out
}

/**
 * Pure compute: the chunk-metadata patches implied by the seed's current code
 * evidence. Exported for unit testing without a vector store.
 */
export function computeCodeBackfill(seedPath: string): ChunkMetadataPatch[] {
  const highlightUtterance = readHighlightUtterances(seedPath)
  const utteranceText = readUtteranceText(seedPath)

  // utterance key → {code ids, codebook frames} covering it.
  const perUtterance = new Map<string, { codeIds: Set<string>; codebookIds: Set<string> }>()
  for (const code of readCodes(seedPath)) {
    for (const highlightId of code.evidence) {
      const key = highlightUtterance.get(highlightId)
      if (key === undefined) continue
      let agg = perUtterance.get(key)
      if (agg === undefined) {
        agg = { codeIds: new Set(), codebookIds: new Set() }
        perUtterance.set(key, agg)
      }
      agg.codeIds.add(code.id)
      agg.codebookIds.add(code.codebookId)
    }
  }

  const patches: ChunkMetadataPatch[] = []
  for (const [key, agg] of perUtterance) {
    const text = utteranceText.get(key)
    if (text === undefined) continue // highlight references an utterance we can't find
    const code_ids = [...agg.codeIds].sort()
    const codebook_ids = [...agg.codebookIds].sort()
    for (const type of BACKFILLED_CHUNK_TYPES) {
      patches.push({ id: chunkIdFor(text, type), code_ids, codebook_ids })
    }
  }
  return patches
}

/** Compute the patches and apply them to the vector store. Returns the number
 * of chunk rows actually updated. */
export async function backfillCodeIds(seedPath: string, writer: LanceDBWriter): Promise<number> {
  const patches = computeCodeBackfill(seedPath)
  if (patches.length === 0) return 0
  return writer.updateChunkMetadata(patches)
}
