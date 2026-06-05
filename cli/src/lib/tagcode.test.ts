import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { initSeed } from './seed.js'
import { suggestTerms, tagSeed } from './tagcode.js'

describe('suggestTerms', () => {
  it('surfaces recurring multiword phrases above minCount', () => {
    const utts = [
      { text: 'la alerta automática me preocupa' },
      { text: 'cada alerta automática es ruidosa' },
      { text: 'la alerta automática otra vez' },
    ]
    const terms = suggestTerms(utts, { minCount: 2 })
    assert.ok(terms.some((t) => t.phrase === 'alerta automática' && t.count >= 2))
    assert.equal(terms[0]?.term_id, 'T-alerta-automática')
  })

  it('ignores phrases that occur once', () => {
    const terms = suggestTerms([{ text: 'unique phrase here' }], { minCount: 2 })
    assert.equal(terms.length, 0)
  })

  // Conversational filler n-grams must NOT survive suggestion (#171).
  // Pre-fix, the corpus drowned in "you know"(64), "and like"(40), "right like"(38),
  // "and then"(31), "like that"(17) because the stopword filter only dropped
  // *all-stopword* phrases, letting any non-stopword partner ("know", "like")
  // anchor the candidate.
  describe('drops conversational filler / boundary stopwords (#171)', () => {
    const noisy = Array.from({ length: 3 }, () => ({
      text: 'you know and like right like and then like that',
    }))

    it('"you know" is not suggested', () => {
      const t = suggestTerms(noisy, { minCount: 2 })
      assert.ok(!t.some((s) => s.phrase === 'you know'))
    })

    it('"and like" / "right like" / "like that" are not suggested', () => {
      const t = suggestTerms(noisy, { minCount: 2 })
      const phrases = t.map((s) => s.phrase)
      assert.ok(!phrases.includes('and like'))
      assert.ok(!phrases.includes('right like'))
      assert.ok(!phrases.includes('like that'))
      assert.ok(!phrases.includes('and then'))
    })

    it('still surfaces legitimate noun phrases ("alerta automática")', () => {
      const utts = [
        { text: 'la alerta automática me preocupa' },
        { text: 'cada alerta automática es ruidosa' },
        { text: 'la alerta automática otra vez' },
      ]
      const t = suggestTerms(utts, { minCount: 2 })
      assert.ok(t.some((s) => s.phrase === 'alerta automática' && s.count >= 2))
    })

    it('still surfaces "manual override" — content nouns survive', () => {
      const utts = [
        { text: 'manual override needed' },
        { text: 'manual override again' },
        { text: 'manual override prevented escalation' },
      ]
      const t = suggestTerms(utts, { minCount: 2 })
      assert.ok(t.some((s) => s.phrase === 'manual override'))
    })
  })

  // The #1 garbage candidate from real dogfooding was "hour minutes seconds1"(78) —
  // raw .srt timecode markers leaking into utterance text. Any token with a
  // digit is suppressed: never a real noun phrase (#171).
  it('drops n-grams that contain a digit token (timestamp noise) (#171)', () => {
    const utts = Array.from({ length: 5 }, () => ({
      text: 'hour minutes seconds1 alerta automática',
    }))
    const t = suggestTerms(utts, { minCount: 2 })
    assert.ok(!t.some((s) => /seconds\d/.test(s.phrase)))
    assert.ok(!t.some((s) => /\d/.test(s.phrase)))
    // The legitimate phrase still surfaces.
    assert.ok(t.some((s) => s.phrase === 'alerta automática'))
  })
})

describe('tagSeed', () => {
  let work: string
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'compost-tag-'))
  })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  it('suggests without writing when apply is false', () => {
    const { path } = initSeed('demo', { cwd: work })
    const utts = [{ text: 'manual override needed' }, { text: 'manual override again' }]
    const result = tagSeed(path, utts, { apply: false })
    assert.equal(result.applied, false)
    assert.ok(result.suggested.length >= 1)
    assert.ok(!existsSync(join(path, 'glossary/glossary.md')))
  })

  it('writes glossary entries and emits events when apply is true', () => {
    const { path } = initSeed('demo', { cwd: work })
    const utts = [{ text: 'manual override needed' }, { text: 'manual override again' }]
    const result = tagSeed(path, utts, { apply: true })
    assert.ok(result.applied)
    const glossary = readFileSync(join(path, 'glossary/glossary.md'), 'utf8')
    assert.match(glossary, /manual override/)
    assert.ok(existsSync(join(path, '.compost/events.sqlite')))
  })
})
