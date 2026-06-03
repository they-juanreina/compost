import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUBRIC_DIR = join(__dirname, '..', 'rubric.versions')

export const CURRENT_RUBRIC_VERSION = 'v1'

export interface LoadedRubric {
  version: string
  text: string
  sha: string
}

export function loadRubric(version: string = CURRENT_RUBRIC_VERSION): LoadedRubric {
  const text = readFileSync(join(RUBRIC_DIR, `${version}.md`), 'utf8')
  const sha = createHash('sha256').update(text).digest('hex')
  return { version, text, sha }
}

export const PASS_FLOOR = 0.7

export interface ParsedVerdict {
  verdict: 'pass' | 'fail'
  score: number
  dimensions?: Record<string, number>
  explanation: string
}

/** Parse + sanity-check a judge response. Recomputes verdict from score so a
 * model that mislabels pass/fail can't sneak content past the floor. */
export function parseJudgeResponse(raw: unknown): ParsedVerdict {
  if (typeof raw !== 'object' || raw === null) throw new Error('judge response is not an object')
  const r = raw as Record<string, unknown>
  const score = typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : 0
  const explanation = typeof r.explanation === 'string' ? r.explanation : ''
  const dimensions =
    typeof r.dimensions === 'object' && r.dimensions !== null
      ? (r.dimensions as Record<string, number>)
      : undefined
  return {
    verdict: score >= PASS_FLOOR ? 'pass' : 'fail',
    score,
    ...(dimensions !== undefined ? { dimensions } : {}),
    explanation,
  }
}
