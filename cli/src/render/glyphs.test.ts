import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { glyphs, statusGlyph, supportsUnicode } from './glyphs.js'

describe('glyphs', () => {
  it('defaults to UTF-8 when locale is unset/empty', () => {
    assert.equal(supportsUnicode({}), true)
    assert.equal(supportsUnicode({ LANG: '' }), true)
    assert.equal(glyphs({}).ok, '✓')
  })

  it('keeps UTF-8 for a UTF-8 locale', () => {
    assert.equal(supportsUnicode({ LANG: 'en_US.UTF-8' }), true)
    assert.equal(supportsUnicode({ LC_ALL: 'C.UTF-8' }), true)
  })

  it('degrades to ASCII for a non-UTF-8 locale or COMPOST_ASCII', () => {
    assert.equal(supportsUnicode({ LANG: 'C' }), false)
    assert.equal(supportsUnicode({ LC_CTYPE: 'POSIX' }), false)
    assert.equal(supportsUnicode({ COMPOST_ASCII: '1' }), false)
    const g = glyphs({ LANG: 'C' })
    assert.equal(g.ok, '[OK]')
    assert.equal(g.fail, '[X]')
    assert.equal(g.arrow, '->')
  })

  it('COMPOST_ASCII=0 / empty does not force ASCII', () => {
    assert.equal(supportsUnicode({ COMPOST_ASCII: '0', LANG: 'en_US.UTF-8' }), true)
    assert.equal(supportsUnicode({ COMPOST_ASCII: '', LANG: 'en_US.UTF-8' }), true)
  })

  it('statusGlyph maps ok/warn/fail to the locale-appropriate glyph', () => {
    const utf = { LANG: 'en_US.UTF-8' }
    assert.equal(statusGlyph('ok', utf), '✓')
    assert.equal(statusGlyph('warn', utf), '⚠')
    assert.equal(statusGlyph('fail', utf), '✗')
    const ascii = { LANG: 'C' }
    assert.equal(statusGlyph('ok', ascii), '[OK]')
    assert.equal(statusGlyph('warn', ascii), '[!]')
    assert.equal(statusGlyph('fail', ascii), '[X]')
  })
})
