import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EvalStore } from './db.js'
import { listCases, runGolden } from './golden.js'
import { gradeSuggestions, type Suggestion } from './grader.js'
import { CURRENT_RUBRIC_VERSION, loadRubric, PASS_FLOOR, parseJudgeResponse } from './rubric.js'

describe('rubric', () => {
  it('loads v1 with a stable sha', () => {
    const r = loadRubric()
    assert.equal(r.version, CURRENT_RUBRIC_VERSION)
    assert.match(r.sha, /^[a-f0-9]{64}$/)
    assert.match(r.text, /Faithfulness/)
  })

  it('parses a judge response and recomputes verdict from score', () => {
    const pass = parseJudgeResponse({ verdict: 'fail', score: 0.9, explanation: 'good' })
    assert.equal(pass.verdict, 'pass') // recomputed: score >= floor overrides the label
    const fail = parseJudgeResponse({ score: 0.3, explanation: 'weak' })
    assert.equal(fail.verdict, 'fail')
  })

  it('clamps score to [0,1]', () => {
    assert.equal(parseJudgeResponse({ score: 5 }).score, 1)
    assert.equal(parseJudgeResponse({ score: -2 }).score, 0)
  })

  it('PASS_FLOOR is 0.7', () => {
    assert.equal(PASS_FLOOR, 0.7)
  })
})

describe('EvalStore', () => {
  it('persists and retrieves a verdict; idempotent on suggestion_id', () => {
    const store = new EvalStore(':memory:')
    const v = {
      suggestion_id: 'EV1',
      verdict: 'pass' as const,
      score: 0.8,
      explanation: 'ok',
      rubric_version: 'v1',
      rubric_sha: 'a'.repeat(64),
      judge_model: 'ollama:llama3.1:8b',
      judge_prompt_hash: 'b'.repeat(64),
      graded_at: '2026-06-03T00:00:00Z',
    }
    store.put(v)
    assert.ok(store.has('EV1'))
    store.put({ ...v, score: 0.95 }) // overwrite
    assert.equal(store.get('EV1')?.score, 0.95)
    store.close()
  })

  it('lists verdicts below the export floor', () => {
    const store = new EvalStore(':memory:')
    const base = {
      verdict: 'fail' as const,
      explanation: '',
      rubric_version: 'v1',
      rubric_sha: 'a'.repeat(64),
      judge_model: 'm',
      judge_prompt_hash: 'b'.repeat(64),
      graded_at: '2026-06-03T00:00:00Z',
    }
    store.put({ ...base, suggestion_id: 'low', score: 0.3 })
    store.put({ ...base, suggestion_id: 'high', score: 0.9, verdict: 'pass' })
    const blocked = store.belowFloor(0.7)
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0]?.suggestion_id, 'low')
    store.close()
  })
})

describe('gradeSuggestions', () => {
  const suggestions: Suggestion[] = [
    { suggestion_id: 'EV1', artifact_kind: 'code', payload: { name: 'distrust' }, evidence: [] },
    { suggestion_id: 'EV2', artifact_kind: 'term', payload: { term_id: 'T-x' }, evidence: [] },
  ]

  it('grades each suggestion once and writes verdicts', async () => {
    const store = new EvalStore(':memory:')
    let calls = 0
    const judge = async () => {
      calls += 1
      return { score: 0.85, explanation: 'fine' }
    }
    const { graded, skipped } = await gradeSuggestions(store, suggestions, judge, {
      judgeModel: 'ollama:llama3.1:8b',
      now: () => new Date('2026-06-03T00:00:00Z'),
    })
    assert.equal(graded.length, 2)
    assert.equal(skipped, 0)
    assert.equal(calls, 2)
    assert.equal(graded[0]?.rubric_version, 'v1')
    assert.match(graded[0]?.judge_prompt_hash ?? '', /^[a-f0-9]{64}$/)
    store.close()
  })

  it('is idempotent — already-graded suggestions are skipped', async () => {
    const store = new EvalStore(':memory:')
    const judge = async () => ({ score: 0.85, explanation: 'fine' })
    const opts = { judgeModel: 'm', now: () => new Date('2026-06-03T00:00:00Z') }
    await gradeSuggestions(store, suggestions, judge, opts)
    const second = await gradeSuggestions(store, suggestions, judge, opts)
    assert.equal(second.graded.length, 0)
    assert.equal(second.skipped, 2)
    store.close()
  })

  it('throttles to maxPerRun', async () => {
    const store = new EvalStore(':memory:')
    const many: Suggestion[] = Array.from({ length: 10 }, (_, i) => ({
      suggestion_id: `EV${i}`,
      artifact_kind: 'code',
      payload: {},
      evidence: [],
    }))
    const { graded } = await gradeSuggestions(
      store,
      many,
      async () => ({ score: 0.8, explanation: '' }),
      {
        judgeModel: 'm',
        maxPerRun: 3,
        now: () => new Date('2026-06-03T00:00:00Z'),
      },
    )
    assert.equal(graded.length, 3)
    store.close()
  })
})

describe('golden runner', () => {
  it('lists the shipped cases per skill (≥1 each, with an es-CO case)', () => {
    for (const skill of ['querying-research-knowledge', 'thematic-coding', 'saturation-analysis']) {
      assert.ok(listCases(skill).length >= 1, `${skill} has no cases`)
    }
  })

  it('a perfect runner (returns expected) scores full coverage and passes', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'golden-'))
    const caseDir = join(root, 'demo-skill', 'case-1')
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(join(caseDir, 'input.json'), JSON.stringify({ q: 'trust?' }))
    const expected = { answer: 'participants distrust alerts', codes: ['distrust'] }
    writeFileSync(join(caseDir, 'expected.json'), JSON.stringify(expected))

    const perfect = (_input: unknown, caseName: string) =>
      JSON.parse(readFileSync(join(root, 'demo-skill', caseName, 'expected.json'), 'utf8'))
    const result = await runGolden('demo-skill', perfect, root)
    assert.ok(result.passed)
    assert.equal(result.cases[0]?.coverage, 1)
  })

  it('a runner that throws fails schema conformance', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'golden-'))
    const caseDir = join(root, 'demo-skill', 'case-1')
    mkdirSync(caseDir, { recursive: true })
    writeFileSync(join(caseDir, 'input.json'), JSON.stringify({ q: 'x' }))
    writeFileSync(join(caseDir, 'expected.json'), JSON.stringify({ a: 'y' }))
    const result = await runGolden(
      'demo-skill',
      () => {
        throw new Error('skill failed')
      },
      root,
    )
    assert.equal(result.passed, false)
    assert.equal(result.cases[0]?.schema_conformance, 0)
  })
})
