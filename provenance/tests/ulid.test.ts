import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { generateUlid, isUlid, monotonicUlid } from '../src/ulid.js'

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

describe('monotonicUlid (ADR 0008 replay order)', () => {
  it('ids minted in the same millisecond sort in creation order', () => {
    const next = monotonicUlid({ now: () => 1700000000000 })
    const ids = Array.from({ length: 500 }, () => next())
    assert.deepEqual([...ids].sort(), ids)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(
      ids.every((u) => u.slice(0, 10) === ids[0]?.slice(0, 10)),
      'time prefix held',
    )
  })

  it('holds the timestamp when the clock steps backwards', () => {
    let t = 1700000000005
    const next = monotonicUlid({ now: () => t })
    const a = next()
    t = 1700000000001
    const b = next()
    assert.ok(a < b, `${a} should sort before ${b}`)
  })

  it('redraws randomness once the clock advances', () => {
    let t = 1700000000000
    const next = monotonicUlid({ now: () => t, random: () => 42n })
    const a = next()
    t += 1
    const b = next()
    assert.ok(a < b)
    assert.equal(b.slice(10), a.slice(10), 'a fresh draw (same injected value), not an increment')
  })
})
