import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRAME_GOLDEN_DIR = join(__dirname, '..', 'golden', 'frame-annotation')

export interface FrameCase {
  case: string
  frame_path: string
  linked_text: string
  expected_keywords: string[]
}

export interface FrameScore {
  case: string
  recall: number
  passed: boolean
}

/** A frame annotator returns a one-sentence description for (frame, linked
 * utterance). The real one is Claude-with-vision / Moondream2; injected here. */
export type FrameAnnotator = (frame: FrameCase) => Promise<string> | string

export const FRAME_PASS_RECALL = 0.5

export function loadFrameCases(root: string = FRAME_GOLDEN_DIR): FrameCase[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'case.json')))
    .sort()
    .map((d) => ({ case: d, ...JSON.parse(readFileSync(join(root, d, 'case.json'), 'utf8')) }))
}

/** Score an annotator against the golden set: recall = fraction of expected
 * keywords present (case-insensitive) in the produced description (#68). */
export async function runFrameGolden(
  annotator: FrameAnnotator,
  root: string = FRAME_GOLDEN_DIR,
): Promise<{ cases: FrameScore[]; passed: boolean }> {
  const cases: FrameScore[] = []
  for (const fc of loadFrameCases(root)) {
    const desc = (await annotator(fc)).toLowerCase()
    const hits = fc.expected_keywords.filter((k) => desc.includes(k.toLowerCase())).length
    const recall = fc.expected_keywords.length === 0 ? 1 : hits / fc.expected_keywords.length
    cases.push({
      case: fc.case,
      recall: Number(recall.toFixed(3)),
      passed: recall >= FRAME_PASS_RECALL,
    })
  }
  return { cases, passed: cases.length > 0 && cases.every((c) => c.passed) }
}
