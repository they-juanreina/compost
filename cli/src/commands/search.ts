import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { buildDenseRetriever, retrieveChunks } from '../lib/retrieve.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { renderSearch } from '../render/human.js'

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
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost search "what frustrated users"\n  $ compost search "onboarding" --top-k 15 --seed my-study',
    )
    .action(async (query: string, flags: SearchFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const topK = Number.parseInt(flags.topK ?? '8', 10)
        // Attach the dense (LanceDB) retriever when available; null → BM25-only.
        const dense = await buildDenseRetriever(seedPath)
        const { retrieved, corpus, mode } = await retrieveChunks(seedPath, query, {
          topK: Number.isFinite(topK) && topK > 0 ? topK : 8,
          dense,
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

        // Distinguish "nothing indexed yet" (an upstream ingest/transcribe gap,
        // which first surfaces here as a clean 0 results) from "indexed, but no
        // match for this query" — point the user at the real diagnostic.
        const hint =
          corpus.chunks.length === 0
            ? 'No transcribed sessions are indexed for this seed yet. Run `compost status` to see transcribed/queued counts and `compost jobs` to inspect the ingest/transcribe queue.'
            : results.length === 0
              ? 'Indexed, but nothing matched this query — try different terms.'
              : undefined

        emit(
          {
            status: 'ok',
            command: 'search',
            query,
            indexed_chunks: corpus.chunks.length,
            returned: results.length,
            // 'hybrid' (BM25 + dense via RRF) when the LanceDB index + an
            // embeddings provider are available; 'bm25' otherwise.
            retrieval: mode,
            results,
            ...(hint ? { hint } : {}),
          },
          out,
          renderSearch,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
