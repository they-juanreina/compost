import type { DoctorReport } from '../lib/doctor.js'
import type { StatusSnapshot } from '../lib/status.js'

/** Human-readable summaries for the tutorial-facing verbs (#173). Commands pass
 * these to `emit(..., render)`; machine/JSON output is unaffected. Verbs without
 * a renderer fall back to pretty-printed JSON. */

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return '?'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function renderStatus(s: StatusSnapshot): string {
  const lines: string[] = [`compost — ${s.seeds.length} seed(s) under ${s.root}`]
  for (const seed of s.seeds) {
    const c = seed.counts
    lines.push('')
    lines.push(`  ${seed.name}${seed.status ? `  [${seed.status}]` : ''}`)
    lines.push(
      `    sessions:   ${c.sessions.total} (${c.sessions.transcribed} transcribed, ${c.sessions.queued} queued, ${c.sessions.inbox} in _inbox)`,
    )
    lines.push(`    highlights: ${c.highlights}   codes: ${c.codes}   themes: ${c.themes}`)
    lines.push(`    frames: ${c.frames}   insights: ${c.insights}   legacy: ${c.legacy_assets}`)
    for (const w of seed.warnings) lines.push(`    ⚠ ${w}`)
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
}

export function renderSearch(v: SearchView): string {
  const lines: string[] = [
    `"${v.query}" — ${v.returned} result(s) [${v.retrieval}] of ${v.indexed_chunks} chunks`,
  ]
  for (const [i, r] of v.results.entries()) {
    const t = r.text.replace(/\s+/g, ' ').trim()
    const clipped = t.length > 160 ? `${t.slice(0, 157)}…` : t
    lines.push('')
    lines.push(
      `  ${i + 1}. [${r.session ?? '?'} ${fmtMs(r.start_ms)}–${fmtMs(r.end_ms)}] score ${r.score}`,
    )
    lines.push(`     ${clipped}`)
  }
  return lines.join('\n')
}

export function renderDoctor(r: DoctorReport): string {
  const lines: string[] = [`models doctor — ${r.ok ? 'OK' : 'ISSUES'}`, '  providers:']
  for (const [name, h] of Object.entries(r.providers)) {
    lines.push(
      `    ${h.ok ? '✓' : '✗'} ${name}${h.ok ? ` (${h.model_list.length} models, ${h.latency_ms}ms)` : ` — ${h.error ?? 'down'}`}`,
    )
  }
  lines.push('  tasks:')
  for (const t of r.tasks) {
    lines.push(
      `    ${t.status === 'ok' ? '✓' : '✗'} ${t.task} → ${t.route}${t.status === 'ok' ? '' : `  [${t.status}]`}${t.suggestion ? `  ↳ ${t.suggestion}` : ''}`,
    )
  }
  const unused = Object.entries(r.unused_models)
  if (unused.length > 0) {
    lines.push('  pulled but unconfigured:')
    for (const [p, ms] of unused) lines.push(`    ${p}: ${ms.join(', ')}`)
  }
  return lines.join('\n')
}
