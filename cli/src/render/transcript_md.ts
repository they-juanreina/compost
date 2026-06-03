import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { transcriptToMarkdown } from '../exporters/md.js'
import type { Transcript } from '../lib/transcript.js'

/** Render transcript.json → transcript.md (cues + silences inlined) next to it.
 * Reuses the Markdown exporter (#24) so the human mirror and `compost export`
 * stay byte-identical. Returns the path written. */
export function writeTranscriptMd(transcriptJsonPath: string): string {
  const transcript = JSON.parse(readFileSync(transcriptJsonPath, 'utf8')) as Transcript
  const md = transcriptToMarkdown(transcript)
  const mdPath = join(dirname(transcriptJsonPath), 'transcript.md')
  writeFileSync(mdPath, md, 'utf8')
  return mdPath
}
