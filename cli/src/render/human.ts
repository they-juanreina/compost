import type { DoctorReport } from '../lib/doctor.js'
import type { EvidenceQuote, ListResult, ThemeEvidenceDetail } from '../lib/list.js'
import type { StatusSnapshot } from '../lib/status.js'
import { glyphs } from './glyphs.js'

/** Human-readable summaries for the tutorial-facing verbs (#173). Commands pass
 * these to `emit(..., render)`; machine/JSON output is unaffected. Verbs without
 * a renderer fall back to pretty-printed JSON. */

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return '?'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function renderStatus(s: StatusSnapshot): string {
  const g = glyphs()
  const lines: string[] = [`compost — ${s.seeds.length} seed(s) under ${s.root}`]
  for (const seed of s.seeds) {
    const c = seed.counts
    lines.push('')
    lines.push(`  ${seed.name}${seed.status ? `  [${seed.status}]` : ''}`)
    lines.push(
      `    sessions:   ${c.sessions.total} (${c.sessions.transcribed} transcribed, ${c.sessions.queued} queued, ${c.sessions.inbox} in _inbox)`,
    )
    lines.push(`    highlights: ${c.highlights}   codes: ${c.codes}   themes: ${c.themes}`)
    lines.push(
      `    memos: ${c.memos}   frames: ${c.frames}   insights: ${c.insights}   legacy: ${c.legacy_assets}`,
    )
    if (seed.by_state !== undefined) {
      const b = seed.by_state
      const fmt = (k: keyof typeof b) =>
        `${k} ${b[k].draft} draft / ${b[k].endorsed} endorsed / ${b[k].archived} archived`
      lines.push(`    ledger:     ${fmt('highlights')}   ${fmt('codes')}`)
      lines.push(`                ${fmt('themes')}   ${fmt('memos')}`)
    }
    for (const w of seed.warnings) lines.push(`    ${g.warn} ${w}`)
  }
  return lines.join('\n')
}

interface SearchView {
  query: string
  returned: number
  retrieval: string
  indexed_chunks: number
  results: Array<{
    session?: string
    start_ms?: number
    end_ms?: number
    score: number
    text: string
  }>
  /** Optional guidance when 0 results — points at the real upstream cause. */
  hint?: string
}

export function renderSearch(v: SearchView): string {
  const g = glyphs()
  const lines: string[] = [
    `"${v.query}" — ${v.returned} result(s) [${v.retrieval}] of ${v.indexed_chunks} chunks`,
  ]
  for (const [i, r] of v.results.entries()) {
    const t = r.text.replace(/\s+/g, ' ').trim()
    const clipped = t.length > 160 ? `${t.slice(0, 157)}${g.ellipsis}` : t
    lines.push('')
    lines.push(
      `  ${i + 1}. [${r.session ?? '?'} ${fmtMs(r.start_ms)}–${fmtMs(r.end_ms)}] score ${r.score}`,
    )
    lines.push(`     ${clipped}`)
  }
  if (v.hint !== undefined) {
    lines.push('')
    lines.push(`  ${g.arrow} ${v.hint}`)
  }
  return lines.join('\n')
}

export function renderDoctor(r: DoctorReport): string {
  const g = glyphs()
  const lines: string[] = [`models doctor — ${r.ok ? 'OK' : 'ISSUES'}`, '  providers:']
  for (const [name, h] of Object.entries(r.providers)) {
    lines.push(
      `    ${h.ok ? g.ok : g.fail} ${name}${h.ok ? ` (${h.model_list.length} models, ${h.latency_ms}ms)` : ` — ${h.error ?? 'down'}`}`,
    )
  }
  lines.push('  tasks:')
  for (const t of r.tasks) {
    lines.push(
      `    ${t.status === 'ok' ? g.ok : g.fail} ${t.task} → ${t.route}${t.status === 'ok' ? '' : `  [${t.status}]`}${t.suggestion ? `  ${g.arrow} ${t.suggestion}` : ''}`,
    )
  }
  const unused = Object.entries(r.unused_models)
  if (unused.length > 0) {
    lines.push('  pulled but unconfigured:')
    for (const [p, ms] of unused) lines.push(`    ${p}: ${ms.join(', ')}`)
  }
  return lines.join('\n')
}

function truncate(text: string, max: number, ellipsis: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}${ellipsis}` : flat
}

function quoteLine(q: EvidenceQuote, ellipsis: string): string {
  const where = q.session_id !== null ? `${q.session_id}/${q.utterance_id ?? '?'}` : '?'
  const quote = q.quote !== null ? `"${truncate(q.quote, 72, ellipsis)}"` : '(quote not found)'
  return `${q.id} ${where} ${quote}`
}

/** `compost list <kind>` as a table: state, id, label, author, last change. */
export function renderList(r: ListResult): string {
  const g = glyphs()
  const lines: string[] = [
    `${r.count} ${r.kind}(s) — state: ${r.state === 'active' ? 'draft + endorsed' : r.state}${r.codebook !== undefined ? `, codebook: ${r.codebook}` : ''}`,
  ]
  if (r.items.length > 0) {
    const idW = Math.min(40, Math.max(2, ...r.items.map((i) => i.id.length)))
    lines.push('')
    lines.push(
      `  ${'STATE'.padEnd(9)} ${'ID'.padEnd(idW)}  ${'LABEL'.padEnd(40)}  ${'AUTHOR'.padEnd(36)}  UPDATED`,
    )
    for (const i of r.items) {
      const author = truncate(`${i.author.actor_type}:${i.author.actor_id}`, 36, g.ellipsis)
      lines.push(
        `  ${i.state.padEnd(9)} ${i.id.padEnd(idW)}  ${truncate(i.label, 40, g.ellipsis).padEnd(40)}  ${author.padEnd(36)}  ${i.updated_at.slice(0, 16).replace('T', ' ')}`,
      )
      if (i.evidence === undefined) continue
      for (const e of i.evidence) {
        if ('highlights' in e) {
          const t = e as ThemeEvidenceDetail
          lines.push(
            `      ${g.arrow} ${t.kind} ${t.ref}${t.highlights.length === 0 ? ' (no quotes)' : ''}`,
          )
          for (const q of t.highlights) lines.push(`          ${quoteLine(q, g.ellipsis)}`)
        } else {
          lines.push(`      ${g.arrow} ${quoteLine(e as EvidenceQuote, g.ellipsis)}`)
        }
      }
    }
  }
  if (r.file_only.length > 0) {
    lines.push('')
    lines.push(
      `  ${g.warn} ${r.file_only.length} ${r.kind} file(s) with no ledger record (no provenance, so no state): ${r.file_only.map((f) => f.id).join(', ')}`,
    )
  }
  return lines.join('\n')
}
