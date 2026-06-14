import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Embedder, extractiveTitle, titleCandidates } from './memoTitles.js'

describe('titleCandidates', () => {
  it('splits lines + sentences, strips headings, dedups, drops tiny fragments', () => {
    const c = titleCandidates('# A Heading\n\nFirst thought here. Second one too!\nok\n# A Heading')
    assert.deepEqual(c, ['A Heading', 'First thought here.', 'Second one too!'])
    // "ok" (<3 chars after... actually 2) dropped; duplicate heading deduped.
  })

  it('returns [] for empty/whitespace content', () => {
    assert.deepEqual(titleCandidates('   \n\n'), [])
  })
})

describe('extractiveTitle', () => {
  // A fake embedder: each candidate maps to a fixed vector by lookup, so the
  // centroid-closest candidate is deterministic (no provider needed).
  const fakeEmbed =
    (vectorsByText: Record<string, number[]>): Embedder =>
    async (texts) =>
      texts.map((t) => vectorsByText[t] ?? [0, 0])

  it('picks the candidate closest to the centroid (most representative)', async () => {
    // Three candidates; B sits between A and C → closest to the mean.
    const content = 'Alpha far out.\nBeta in the middle.\nGamma also far.'
    const embed = fakeEmbed({
      'Alpha far out.': [1, 0],
      'Beta in the middle.': [1, 1],
      'Gamma also far.': [0, 1],
    })
    assert.equal(await extractiveTitle(content, embed), 'Beta in the middle.')
  })

  it('returns the sole candidate without embedding', async () => {
    let called = false
    const embed: Embedder = async (t) => {
      called = true
      return t.map(() => [1])
    }
    assert.equal(await extractiveTitle('just one line', embed), 'just one line')
    assert.equal(called, false)
  })

  it('returns null when there is no candidate', async () => {
    assert.equal(await extractiveTitle('  \n\n', async () => []), null)
  })

  it('clips a long candidate to a title length', async () => {
    const long = `${'word '.repeat(40)}.`
    const out = await extractiveTitle(long, async (t) => t.map(() => [1]))
    assert.ok(out !== null && out.length <= 80 && out.endsWith('…'))
  })
})
