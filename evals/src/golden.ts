import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(__dirname, '..', 'golden')

export interface GoldenScore {
  case: string
  coverage: number
  faithfulness: number
  schema_conformance: number
  passed: boolean
}

export interface GoldenRunResult {
  skill: string
  cases: GoldenScore[]
  passed: boolean
}

/** A skill runner produces an output object for a case input. Injected so the
 * golden runner is testable without invoking real skills/LLMs. */
export type SkillRunner = (input: unknown, caseName: string) => Promise<unknown> | unknown

export const PASS_THRESHOLD = 0.7

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  const inter = [...a].filter((x) => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

function collectStrings(value: unknown, acc: Set<string>): void {
  if (typeof value === 'string') acc.add(value.toLowerCase().trim())
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc)
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) collectStrings(v, acc)
}

/** Coverage = jaccard over the string leaves of expected vs actual. */
function coverage(expected: unknown, actual: unknown): number {
  const e = new Set<string>()
  const a = new Set<string>()
  collectStrings(expected, e)
  collectStrings(actual, a)
  return jaccard(e, a)
}

export function listCases(skill: string, goldenRoot: string = GOLDEN_DIR): string[] {
  const dir = join(goldenRoot, skill)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((d) => /^case-\d+$/.test(d))
    .sort()
}

export async function runGolden(
  skill: string,
  runner: SkillRunner,
  goldenRoot: string = GOLDEN_DIR,
): Promise<GoldenRunResult> {
  const cases = listCases(skill, goldenRoot)
  const scores: GoldenScore[] = []
  for (const c of cases) {
    const dir = join(goldenRoot, skill, c)
    const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'))
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'))
    let actual: unknown
    let schemaOk = 1
    try {
      actual = await runner(input, c)
    } catch {
      actual = {}
      schemaOk = 0
    }
    const cov = coverage(expected, actual)
    // faithfulness here = does actual avoid introducing string leaves absent
    // from the input+expected (a cheap hallucination proxy for the harness).
    const allowed = new Set<string>()
    collectStrings(expected, allowed)
    collectStrings(input, allowed)
    const got = new Set<string>()
    collectStrings(actual, got)
    const extraneous = [...got].filter((g) => !allowed.has(g) && g.length > 3).length
    const faithfulness = got.size === 0 ? 1 : Math.max(0, 1 - extraneous / got.size)
    const passed = cov >= PASS_THRESHOLD && schemaOk === 1
    scores.push({
      case: c,
      coverage: Number(cov.toFixed(3)),
      faithfulness: Number(faithfulness.toFixed(3)),
      schema_conformance: schemaOk,
      passed,
    })
  }
  return { skill, cases: scores, passed: scores.length > 0 && scores.every((s) => s.passed) }
}
