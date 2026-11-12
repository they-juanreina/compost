import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_MAX = (1n << 80n) - 1n
const TIME_LIMIT = 1n << 48n

function encode(value: bigint, length: number): string {
  let v = value
  const chars = new Array<string>(length)
  for (let i = length - 1; i >= 0; i--) {
    const idx = Number(v & 31n)
    chars[i] = CROCKFORD.charAt(idx)
    v >>= 5n
  }
  return chars.join('')
}

function defaultRandom(): bigint {
  const bytes = randomBytes(10)
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

export interface UlidOptions {
  now?: () => number
  random?: () => bigint
}

function readTime(now: () => number): bigint {
  const ts = BigInt(now())
  if (ts < 0n || ts >= TIME_LIMIT) {
    throw new RangeError(`ULID timestamp out of 48-bit range: ${ts}`)
  }
  return ts
}

/**
 * A stateless ULID: 48-bit ms timestamp + 80 random bits. Two values minted in
 * the same millisecond sort in RANDOM order — use `monotonicUlid` (what the
 * EventWriter uses) wherever id order must follow creation order.
 */
export function generateUlid(opts: UlidOptions = {}): string {
  const ts = readTime(opts.now ?? Date.now)
  return encode(ts, 10) + encode((opts.random ?? defaultRandom)(), 16)
}

/**
 * A monotonic ULID generator (the ULID spec's monotonic mode). Within one
 * generator, every id sorts strictly after the previous one: in the same
 * millisecond — or if the clock steps backwards — the timestamp is held and the
 * random part is incremented by one instead of redrawn.
 *
 * Event replay orders by `(ts, id)` (ADR 0008), so this is what keeps two
 * same-millisecond events from one process (e.g. a create then its endorse)
 * replaying in the order they were written.
 */
export function monotonicUlid(opts: UlidOptions = {}): () => string {
  const now = opts.now ?? Date.now
  const random = opts.random ?? defaultRandom
  let lastTime = -1n
  let lastRandom = 0n
  return () => {
    let ts = readTime(now)
    let rnd: bigint
    if (ts <= lastTime) {
      ts = lastTime
      rnd = lastRandom + 1n
      if (rnd > RANDOM_MAX) {
        // 2^80 ids in one ms is unreachable in practice; carry into the next ms
        // rather than wrap (wrapping would sort before the previous id).
        ts += 1n
        rnd = 0n
        if (ts >= TIME_LIMIT) throw new RangeError('ULID timestamp out of 48-bit range')
      }
    } else {
      rnd = random() & RANDOM_MAX
    }
    lastTime = ts
    lastRandom = rnd
    return encode(ts, 10) + encode(rnd, 16)
  }
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}
