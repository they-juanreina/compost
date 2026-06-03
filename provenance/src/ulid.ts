import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

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

export function generateUlid(opts: UlidOptions = {}): string {
  const now = opts.now ?? Date.now
  const random = opts.random ?? defaultRandom
  const ts = BigInt(now())
  if (ts < 0n || ts >= 1n << 48n) {
    throw new RangeError(`ULID timestamp out of 48-bit range: ${ts}`)
  }
  return encode(ts, 10) + encode(random(), 16)
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}
