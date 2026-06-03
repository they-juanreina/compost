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
