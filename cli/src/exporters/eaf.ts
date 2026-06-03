import type { Transcript } from '../lib/transcript.js'

// ELAN .eaf (EAF 3.0) export. Tiers: one per speaker for utterances, one per
// cue kind, one for silences, one for frame annotations. ELAN reads absolute
// time slots (ms) referenced by annotations.

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface TimeSlot {
  id: string
  value: number
}

interface AnnotationRow {
  tier: string
  start: number
  end: number
  text: string
}

export function transcriptToEaf(transcript: Transcript, mediaUrl?: string): string {
  const slots: TimeSlot[] = []
  const slotByMs = new Map<number, string>()
  const slotId = (ms: number): string => {
    const existing = slotByMs.get(ms)
    if (existing !== undefined) return existing
    const id = `ts${slots.length + 1}`
    slots.push({ id, value: ms })
    slotByMs.set(ms, id)
    return id
  }

  const speakerName = new Map(transcript.speakers.map((s) => [s.id, s.name ?? s.id]))
  const rows: AnnotationRow[] = []

  for (const u of transcript.utterances) {
    rows.push({
      tier: `utterance@${speakerName.get(u.speaker_id) ?? u.speaker_id}`,
      start: u.start_ms,
      end: Math.max(u.end_ms, u.start_ms + 1),
      text: u.text,
    })
  }
  for (const s of transcript.silences ?? []) {
    rows.push({
      tier: 'silence',
      start: s.start_ms,
      end: Math.max(s.end_ms, s.start_ms + 1),
      text: s.context,
    })
  }
  for (const c of transcript.cues ?? []) {
    rows.push({
      tier: `cue@${c.kind}`,
      start: c.start_ms,
      end: Math.max(c.end_ms, c.start_ms + 1),
      text: c.kind,
    })
  }
  for (const f of transcript.frames ?? []) {
    if (f.annotation === undefined) continue
    rows.push({ tier: 'frame-annotation', start: f.at_ms, end: f.at_ms + 1, text: f.annotation })
  }

  // Assign time slots + build annotation XML grouped by tier.
  const tiers = new Map<string, string[]>()
  let annId = 0
  for (const r of rows) {
    annId += 1
    const ref1 = slotId(r.start)
    const ref2 = slotId(r.end)
    const ann = `      <ANNOTATION>
        <ALIGNABLE_ANNOTATION ANNOTATION_ID="a${annId}" TIME_SLOT_REF1="${ref1}" TIME_SLOT_REF2="${ref2}">
          <ANNOTATION_VALUE>${xmlEscape(r.text)}</ANNOTATION_VALUE>
        </ALIGNABLE_ANNOTATION>
      </ANNOTATION>`
    const list = tiers.get(r.tier) ?? []
    list.push(ann)
    tiers.set(r.tier, list)
  }

  const slotXml = slots
    .map((s) => `    <TIME_SLOT TIME_SLOT_ID="${s.id}" TIME_VALUE="${s.value}"/>`)
    .join('\n')

  const tierXml = [...tiers.entries()]
    .map(
      ([tier, anns]) =>
        `  <TIER LINGUISTIC_TYPE_REF="default" TIER_ID="${xmlEscape(tier)}">\n${anns.join('\n')}\n  </TIER>`,
    )
    .join('\n')

  const media = mediaUrl ?? transcript.source
  return `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT AUTHOR="compost" DATE="1970-01-01T00:00:00+00:00" FORMAT="3.0" VERSION="3.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.mpi.nl/tools/elan/EAFv3.0.xsd">
  <HEADER MEDIA_FILE="" TIME_UNITS="milliseconds">
    <MEDIA_DESCRIPTOR MEDIA_URL="${xmlEscape(media)}" MIME_TYPE="video/mp4"/>
    <PROPERTY NAME="compost:session_id">${xmlEscape(transcript.session_id)}</PROPERTY>
  </HEADER>
  <TIME_ORDER>
${slotXml}
  </TIME_ORDER>
${tierXml}
  <LINGUISTIC_TYPE GRAPHIC_REFERENCES="false" LINGUISTIC_TYPE_ID="default" TIME_ALIGNABLE="true"/>
</ANNOTATION_DOCUMENT>
`
}
