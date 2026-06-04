import { extname } from 'node:path'

import type { JobKind } from './queue.js'

export interface Dispatch {
  kind: JobKind
  category: 'audio' | 'video' | 'document' | 'tabular' | 'markdown'
  ext: string
}

const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'])
const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])
const DOCUMENT = new Set(['.pdf', '.docx', '.pptx'])
// `.xlsx` lands under tabular (column-mapped via openpyxl in legacy ingest).
// `.txt` lands under markdown (Otter/Zoom exports often arrive as plain text).
const TABULAR = new Set(['.csv', '.tsv', '.xlsx'])
const MARKDOWN = new Set(['.md', '.markdown', '.txt'])

/** Classify a file by extension into a worker dispatch, or null if unsupported. */
export function classify(path: string): Dispatch | null {
  const ext = extname(path).toLowerCase()
  if (AUDIO.has(ext)) return { kind: 'transcribe', category: 'audio', ext }
  if (VIDEO.has(ext)) return { kind: 'transcribe', category: 'video', ext }
  if (DOCUMENT.has(ext)) return { kind: 'legacy-ingest', category: 'document', ext }
  if (TABULAR.has(ext)) return { kind: 'legacy-ingest', category: 'tabular', ext }
  if (MARKDOWN.has(ext)) return { kind: 'legacy-ingest', category: 'markdown', ext }
  return null
}

export const SUPPORTED_EXTENSIONS = [
  ...AUDIO,
  ...VIDEO,
  ...DOCUMENT,
  ...TABULAR,
  ...MARKDOWN,
].sort()
