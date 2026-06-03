import type { Transcript, TranscriptCue, TranscriptSilence } from '../lib/transcript.js'

type TimelineItem =
  | { kind: 'utterance'; at: number; render: string }
  | { kind: 'silence'; at: number; render: string }
  | { kind: 'cue'; at: number; render: string }

function fmtSilence(s: TranscriptSilence): string {
  const secs = (s.duration_ms / 1000).toFixed(1)
  return `_[silence ${secs}s — ${s.context}]_`
}

function fmtCue(c: TranscriptCue): string {
  return `_[${c.kind}]_`
}

export function transcriptToMarkdown(transcript: Transcript): string {
  const speakerById = new Map(transcript.speakers.map((s) => [s.id, s]))
  const items: TimelineItem[] = []

  for (const u of transcript.utterances) {
    const speaker = speakerById.get(u.speaker_id)
    const label = speaker?.name ?? u.speaker_id
    const annotation = u.annotation !== undefined ? `\n  > _${u.annotation}_` : ''
    items.push({
      kind: 'utterance',
      at: u.start_ms,
      render: `**${label}:** ${u.text}${annotation}`,
    })
  }
  for (const s of transcript.silences ?? []) {
    items.push({ kind: 'silence', at: s.start_ms, render: fmtSilence(s) })
  }
  for (const c of transcript.cues ?? []) {
    items.push({ kind: 'cue', at: c.start_ms, render: fmtCue(c) })
  }

  // Stable sort by timestamp; utterances before silences/cues at the same ms.
  const order = { utterance: 0, cue: 1, silence: 2 } as const
  items.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind])

  const header = [
    `# ${transcript.session_id}`,
    '',
    `- **Source:** \`${transcript.source}\``,
    `- **Language:** ${transcript.language}`,
    `- **Duration:** ${(transcript.duration_ms / 1000 / 60).toFixed(1)} min`,
    `- **Speakers:** ${transcript.speakers.map((s) => `${s.name ?? s.id} (${s.type})`).join(', ')}`,
    '',
    '---',
    '',
  ]
  return `${header.join('\n')}${items.map((i) => i.render).join('\n\n')}\n`
}
