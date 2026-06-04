import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { retrieveChunks } from '../lib/retrieve.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface SearchFlags {
  seed?: string
  topK?: string
}

export function registerSearch(program: Command): void {
  program
    .command('search')
    .description(
      'Retrieve ranked passages from the seed corpus (no LLM). The host agent reasons over the results.',
    )
    .argument('<query>', 'Free-text query')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--top-k <n>', 'Number of passages to return', '8')
    .action(async (query: string, flags: SearchFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const topK = Number.parseInt(flags.topK ?? '8', 10)
        const { retrieved, corpus } = await retrieveChunks(seedPath, query, {
          topK: Number.isFinite(topK) && topK > 0 ? topK : 8,
        })

        const results = retrieved.map((c) => ({
          chunk_id: c.id,
          session: c.metadata.session,
          speaker_id: c.metadata.speaker_id,
          start_ms: c.metadata.start_ms,
          end_ms: c.metadata.end_ms,
          chunk_type: c.metadata.chunk_type,
          score: Number(c.score.toFixed(4)),
          text: c.text,
        }))

        emit(
          {
            status: 'ok',
            command: 'search',
            query,
            indexed_chunks: corpus.chunks.length,
            returned: results.length,
            // BM25-only today; dense/LanceDB ranking is a follow-up (#137-adjacent).
            retrieval: 'bm25',
            results,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
