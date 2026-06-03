import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runFrameGolden } from './frame_golden.js'
import { runHarness } from './harness.js'

describe('runHarness (#67)', () => {
  it('passes when the pipeline reproduces the expected synthesis artifact', async () => {
    const pipeline = async () => ({
      themes: {
        themes: [
          {
            name: 'control-earns-trust',
            codes: ['distrust-of-automation', 'desire-for-manual-override'],
          },
        ],
      },
    })
    const result = await runHarness(pipeline)
    assert.ok(result.cases.length >= 1)
    assert.ok(result.passed)
  })

  it('fails when the produced artifact diverges from expected', async () => {
    const pipeline = async () => ({ themes: { themes: [{ name: 'wrong', codes: [] }] } })
    const result = await runHarness(pipeline)
    assert.equal(result.passed, false)
    assert.ok(result.cases.some((c) => c.detail?.includes('expected != produced')))
  })

  it('is order-insensitive on object keys (deep JSON equality)', async () => {
    const pipeline = async () => ({
      themes: {
        themes: [
          {
            codes: ['distrust-of-automation', 'desire-for-manual-override'],
            name: 'control-earns-trust',
          },
        ],
      },
    })
    assert.ok((await runHarness(pipeline)).passed)
  })
})

describe('runFrameGolden (#68)', () => {
  it('passes an annotator that hits the expected keywords', async () => {
    const annotator = (fc: { expected_keywords: string[] }) => fc.expected_keywords.join(' ')
    const result = await runFrameGolden(annotator)
    assert.ok(result.cases.length >= 1)
    assert.ok(result.passed)
  })

  it('fails an annotator that misses the keywords (recall below floor)', async () => {
    const result = await runFrameGolden(() => 'a totally unrelated description')
    assert.equal(result.passed, false)
    assert.ok(result.cases.every((c) => c.recall < 0.5))
  })

  it('scores partial recall', async () => {
    // hit exactly one of two keywords in case-1
    const result = await runFrameGolden((fc) => fc.expected_keywords[0] ?? '')
    const c1 = result.cases.find((c) => c.case === 'case-1')
    assert.equal(c1?.recall, 0.5)
  })
})
