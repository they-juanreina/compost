/**
 * Status glyphs with an ASCII fallback (#236 readiness follow-up).
 *
 * The human renderers signal pass/fail/warn with `✓ ✗ ⚠ ↳ …` — shapes, not
 * color, which is the accessible choice. But a terminal under a non-UTF-8 locale
 * renders them as mojibake/replacement boxes on exactly the symbols that carry
 * meaning. This centralizes the glyphs behind one helper that degrades to ASCII.
 *
 * Default is UTF-8 (most modern terminals). It degrades to ASCII when
 * `COMPOST_ASCII` is set, or when a locale var (LC_ALL/LC_CTYPE/LANG) is
 * explicitly set to a non-UTF-8 value. An unset/empty locale is treated as
 * UTF-8-capable, so CI and tests keep the familiar glyphs.
 */

export interface Glyphs {
  ok: string
  fail: string
  warn: string
  arrow: string
  ellipsis: string
}

const UNICODE: Glyphs = { ok: '✓', fail: '✗', warn: '⚠', arrow: '↳', ellipsis: '…' }
const ASCII: Glyphs = { ok: '[OK]', fail: '[X]', warn: '[!]', arrow: '->', ellipsis: '...' }

/** True when the terminal can render the UTF-8 status glyphs. */
export function supportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  const ascii = env.COMPOST_ASCII
  if (ascii !== undefined && ascii.trim() !== '' && ascii !== '0') return false
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  if (locale === undefined || locale.trim() === '') return true // unknown → assume UTF-8
  return /utf-?8/i.test(locale)
}

/** The glyph set appropriate for the current environment. */
export function glyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return supportsUnicode(env) ? UNICODE : ASCII
}
