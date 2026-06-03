import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { generateUlid, isUlid } from '../src/ulid.js'

describe('ulid', () => {
  it('generates a 26-character Crockford base32 string', () => {
    const u = generateUlid()
    assert.equal(u.length, 26)
    assert.ok(isUlid(u), `not a ULID: ${u}`)
  })

  it('emits unique values across many calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateUlid())
    assert.equal(seen.size, 1000)
  })

  it('is monotonic across the timestamp prefix when clock advances', () => {
    let t = 1700000000000
    const a = generateUlid({ now: () => t })
    t += 1
    const b = generateUlid({ now: () => t })
    assert.ok(a.slice(0, 10) <= b.slice(0, 10), `${a} ts >= ${b} ts`)
  })

  it('rejects timestamps outside the 48-bit range', () => {
    assert.throws(() => generateUlid({ now: () => 2 ** 48 + 1 }), RangeError)
  })

  it('uses Crockford alphabet (no I, L, O, U)', () => {
    const u = generateUlid({ now: () => 0, random: () => 0n })
    assert.equal(u, '00000000000000000000000000')
    assert.match(u, /^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
