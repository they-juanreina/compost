import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { reportToHtml } from './html.js'
import { buildDeckSpec, type ReportInput } from './report.js'

const REPORT: ReportInput = {
  seed: 'data-hub',
  title: 'Trust in automated alerts',
  positioning: 'How people decide to trust alerts.',
  themes: [
    {
      name: 'control-earns-trust',
      summary: 'Trust rises with manual override.',
      endorsed: true,
      evidence: [{ utterance_id: 'U-0002', session_id: 'S001', quote: 'no sé si confiar' }],
    },
    {
      name: 'speculative-theme',
      summary: 'An un-endorsed AI draft.',
      endorsed: false,
      evidence: [{ utterance_id: 'U-0003', session_id: 'S001', quote: 'anular la alerta' }],
    },
  ],
  journey: [{ stage: 'Alert fires', emotion: 'doubt', pain_points: ['no override'] }],
  saturation: { recommendation: 'pause', rationale: 'no new themes last session' },
  provenance: { models: ['anthropic:claude-opus-4-7'], generated_at: '2026-06-03T00:00:00Z' },
}

describe('reportToHtml (#65)', () => {
  const html = reportToHtml(REPORT)

  it('has a cover page, TOC, and provenance section', () => {
    assert.match(html, /class="cover"/)
    assert.match(html, /<h2>Contents<\/h2>/)
    assert.match(html, /id="provenance"/)
    assert.match(html, /anthropic:claude-opus-4-7/)
  })

  it('marks un-endorsed AI content with [draft] and leaves endorsed clean', () => {
    assert.match(html, /\[draft\] speculative-theme/)
    assert.ok(!/\[draft\] control-earns-trust/.test(html))
  })

  it('cites evidence with utterance + session', () => {
    assert.match(html, /no sé si confiar/)
    assert.match(html, /U-0002 · S001/)
  })

  it('escapes HTML in user content', () => {
    const evil = reportToHtml({ ...REPORT, title: '<script>x</script>' })
    assert.ok(!evil.includes('<script>x</script>'))
    assert.match(evil, /&lt;script&gt;/)
  })
})

describe('buildDeckSpec (#66)', () => {
  const slides = buildDeckSpec(REPORT)

  it('emits title + per-theme + per-journey + saturation + provenance slides', () => {
    assert.equal(slides[0]?.title, 'Trust in automated alerts')
    assert.ok(slides.some((s) => s.title.includes('control-earns-trust')))
    assert.ok(slides.some((s) => s.title.startsWith('Journey —')))
    assert.ok(slides.some((s) => s.title === 'Saturation'))
    assert.ok(slides.some((s) => s.title === 'Provenance'))
  })

  it('marks un-endorsed theme slides [draft] and puts citations in notes', () => {
    const draft = slides.find((s) => s.title.includes('speculative-theme'))
    assert.ok(draft?.draft)
    assert.match(draft?.notes ?? '', /U-0003.*anular la alerta/)
  })
})

describe('exportReportPdf (#65)', () => {
  it('renders the report HTML through an injected renderer', async () => {
    const { exportReportPdf } = await import('./pdf.js')
    let renderedHtml = ''
    let renderedOut = ''
    const fakeRenderer = (html: string, out: string) => {
      renderedHtml = html
      renderedOut = out
    }
    const html = await exportReportPdf(REPORT, '/tmp/x.pdf', fakeRenderer)
    assert.match(renderedHtml, /class="cover"/)
    assert.equal(renderedOut, '/tmp/x.pdf')
    assert.equal(html, renderedHtml)
  })
})
