import { draftPrefix, type ReportInput } from './report.js'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render the stakeholder report to a self-contained HTML document: cover
 * page, table of contents, themes with cited evidence ([draft] marks for
 * un-endorsed AI content), journey maps, saturation, and a provenance summary. */
export function reportToHtml(report: ReportInput): string {
  const toc = [
    ...report.themes.map((t, i) => `<li><a href="#theme-${i}">${esc(t.name)}</a></li>`),
    '<li><a href="#journey">Journey map</a></li>',
    '<li><a href="#saturation">Saturation</a></li>',
    '<li><a href="#provenance">Provenance</a></li>',
  ].join('\n')

  const themes = report.themes
    .map(
      (t, i) => `<section id="theme-${i}" class="theme">
  <h2>${esc(draftPrefix(t.endorsed))}${esc(t.name)}</h2>
  <p>${esc(t.summary)}</p>
  <ul class="evidence">${t.evidence
    .map(
      (c) =>
        `<li><q>${esc(c.quote)}</q> <cite>${esc(c.utterance_id)} · ${esc(c.session_id)}</cite></li>`,
    )
    .join('')}</ul>
</section>`,
    )
    .join('\n')

  const journey = report.journey
    .map(
      (s) =>
        `<tr><td>${esc(s.stage)}</td><td>${esc(s.emotion)}</td><td>${esc(s.pain_points.map(esc).join('; '))}</td></tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(report.title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 760px; margin: 2rem auto; }
  .cover { page-break-after: always; text-align: center; padding-top: 30vh; }
  .theme { page-break-inside: avoid; }
  .evidence cite { color: #666; font-size: 0.85em; }
  .draft { color: #b45309; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #ddd; padding: 6px; }
</style></head>
<body>
  <div class="cover"><h1>${esc(report.title)}</h1><p>${esc(report.positioning)}</p><p>Seed: ${esc(report.seed)}</p></div>
  <nav><h2>Contents</h2><ol>${toc}</ol></nav>
  ${themes}
  <section id="journey"><h2>Journey map</h2><table><tr><th>Stage</th><th>Emotion</th><th>Pain points</th></tr>${journey}</table></section>
  <section id="saturation"><h2>Saturation</h2><p><strong>${esc(report.saturation.recommendation)}</strong> — ${esc(report.saturation.rationale)}</p></section>
  <section id="provenance"><h2>Provenance</h2><p>Models: ${esc(report.provenance.models.join(', '))}</p><p>Generated: ${esc(report.provenance.generated_at)}</p></section>
</body></html>`
}

/** Renders HTML → PDF. Default shells to a headless Chromium; injected in tests. */
export type PdfRenderer = (html: string, outPath: string) => Promise<void> | void
