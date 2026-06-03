import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARNESS_DIR = join(__dirname, '..', 'harness')

export interface HarnessCaseResult {
  fixture: string
  artifact: string
  matched: boolean
  detail?: string
}

export interface HarnessResult {
  cases: HarnessCaseResult[]
  passed: boolean
}

/** Produces the synthesis artifacts for a complete-seed fixture. Injected so
 * the harness is testable without running the whole pipeline (the CLI wires
 * the real pipeline). Returns a map of artifact name → produced value. */
export type SeedPipeline = (input: unknown, fixture: string) => Promise<Record<string, unknown>>

function listFixtures(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((d) => existsSync(join(root, d, 'input.json')))
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

/**
 * End-to-end harness (#67): run each complete-seed fixture through the pipeline
 * and diff the produced synthesis artifacts against expected/. Gates releases.
 */
export async function runHarness(
  pipeline: SeedPipeline,
  harnessRoot: string = HARNESS_DIR,
): Promise<HarnessResult> {
  const cases: HarnessCaseResult[] = []
  for (const fixture of listFixtures(harnessRoot)) {
    const dir = join(harnessRoot, fixture)
    const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'))
    const expectedDir = join(dir, 'expected')
    const produced = await pipeline(input, fixture)
    for (const file of existsSync(expectedDir) ? readdirSync(expectedDir) : []) {
      if (!file.endsWith('.json')) continue
      const artifact = file.replace(/\.json$/, '')
      const expected = JSON.parse(readFileSync(join(expectedDir, file), 'utf8'))
      const got = produced[artifact]
      const matched = got !== undefined && deepEqualJson(got, expected)
      cases.push({
        fixture,
        artifact,
        matched,
        ...(matched ? {} : { detail: `expected != produced for ${artifact}` }),
      })
    }
  }
  return { cases, passed: cases.length > 0 && cases.every((c) => c.matched) }
}
