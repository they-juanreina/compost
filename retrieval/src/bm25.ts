import type { Chunk, ScoredChunk } from './types.js'

const K1 = 1.5
const B = 0.75

export function tokenize(text: string): string[] {
  // Keep precomposed accented letters intact (no NFKD — it splits "confías"
  // into base + combining mark, fragmenting Spanish tokens).
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/** In-memory BM25 index over chunks. Small corpora (one seed) — no server. */
export class BM25Index {
  private readonly docs: Chunk[] = []
  private readonly termFreq: Array<Map<string, number>> = []
  private readonly docFreq = new Map<string, number>()
  private readonly lengths: number[] = []
  private avgLen = 0

  add(chunk: Chunk): void {
    const tokens = tokenize(chunk.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1)
    this.docs.push(chunk)
    this.termFreq.push(tf)
    this.lengths.push(tokens.length)
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / this.lengths.length
  }

  addAll(chunks: Chunk[]): void {
    for (const c of chunks) this.add(c)
  }

  private idf(term: string): number {
    const n = this.docs.length
    const df = this.docFreq.get(term) ?? 0
    // BM25+ idf, always positive
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  search(query: string, k = 50): ScoredChunk[] {
    const qTerms = [...new Set(tokenize(query))]
    const scored: ScoredChunk[] = []
    for (let i = 0; i < this.docs.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: termFreq is kept in lockstep with docs (every add() pushes both), so index i < docs.length is in-bounds
      const tf = this.termFreq[i]!
      // biome-ignore lint/style/noNonNullAssertion: lengths is kept in lockstep with docs (every add() pushes both), so index i < docs.length is in-bounds
      const len = this.lengths[i]!
      let score = 0
      for (const term of qTerms) {
        const f = tf.get(term) ?? 0
        if (f === 0) continue
        const denom = f + K1 * (1 - B + (B * len) / (this.avgLen || 1))
        score += this.idf(term) * ((f * (K1 + 1)) / denom)
      }
      // biome-ignore lint/style/noNonNullAssertion: i < docs.length per the loop condition, so docs[i] is in-bounds
      if (score > 0) scored.push({ ...this.docs[i]!, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }
}
