// Shared report model for PDF (#65) and PPTX (#66) exports.

export interface Citation {
  utterance_id: string
  session_id: string
  quote: string
}

export interface ReportTheme {
  name: string
  summary: string
  endorsed: boolean
  evidence: Citation[]
}

export interface JourneyStage {
  stage: string
  emotion: string
  pain_points: string[]
}

export interface ReportInput {
  seed: string
  title: string
  positioning: string
  themes: ReportTheme[]
  journey: JourneyStage[]
  saturation: { recommendation: string; rationale: string }
  provenance: { models: string[]; generated_at: string }
}

export interface DeckSlide {
  title: string
  bullets: string[]
  notes: string
  draft: boolean
}

/** Decision #76: un-endorsed AI content is marked [draft] in exports. */
export function draftPrefix(endorsed: boolean): string {
  return endorsed ? '' : '[draft] '
}

/** Build a PPTX deck spec: title, one slide per theme + per journey stage,
 * a saturation summary, and a provenance slide. Citations become slide notes. */
export function buildDeckSpec(report: ReportInput): DeckSlide[] {
  const slides: DeckSlide[] = []
  slides.push({
    title: report.title,
    bullets: [report.positioning],
    notes: `Seed: ${report.seed}`,
    draft: false,
  })
  for (const t of report.themes) {
    slides.push({
      title: `${draftPrefix(t.endorsed)}${t.name}`,
      bullets: [t.summary],
      notes: t.evidence.map((c) => `${c.utterance_id} (${c.session_id}): "${c.quote}"`).join('\n'),
      draft: !t.endorsed,
    })
  }
  for (const s of report.journey) {
    slides.push({
      title: `Journey — ${s.stage}`,
      bullets: [`Emotion: ${s.emotion}`, ...s.pain_points.map((p) => `Pain: ${p}`)],
      notes: '',
      draft: true,
    })
  }
  slides.push({
    title: 'Saturation',
    bullets: [`Recommendation: ${report.saturation.recommendation}`, report.saturation.rationale],
    notes: '',
    draft: false,
  })
  slides.push({
    title: 'Provenance',
    bullets: [
      `Models: ${report.provenance.models.join(', ')}`,
      `Generated: ${report.provenance.generated_at}`,
    ],
    notes: '',
    draft: false,
  })
  return slides
}
