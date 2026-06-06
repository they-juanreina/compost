import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EmbeddedItem, suggestCodeClusters } from '@they-juanreina/compost-retrieval'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { defaultResearcherId } from '../lib/artifacts.js'
import { type Regenerator, rerunEvent } from '../lib/rerun.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface RerunFlags {
  seed?: string
  apply?: boolean
  model?: string
}

function loadEmbeddedHighlights(seedPath: string): EmbeddedItem[] {
  const dir = join(seedPath, 'highlights')
  if (!existsSync(dir)) return []
  const out: EmbeddedItem[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string; vector?: number[] }
      if (typeof j.id === 'string' && Array.isArray(j.vector))
        out.push({ id: j.id, vector: j.vector })
    } catch {
      // skip malformed
    }
  }
  return out
}

/**
 * Default regeneration. Deterministic agent artifacts (the similarity-scanner)
 * re-cluster the current embeddings with the captured params — provider-free and
 * exactly reproducible when embeddings are unchanged. LLM (`ai`) regeneration
 * needs model-routed provider access and is not wired yet (the inputs are intact;
 * the foundation is there).
 */
function makeDefaultRegenerator(seedPath: string): Regenerator {
  return async (inputs, ctx) => {
    if (ctx.actorType === 'ai') {
      throw new CompostError(
        'CONFIG_ERROR',
        'Automatic LLM regeneration is not wired yet (needs model-routed provider access). ' +
          'The inputs are intact and reconstructable — `compost rerun <event>` (verify) confirms it; ' +
          '--apply currently regenerates deterministic agent artifacts only.',
      )
    }
    const highlights = loadEmbeddedHighlights(seedPath)
    const threshold =
      typeof inputs.params?.threshold === 'number' ? (inputs.params.threshold as number) : 0.75
    const clusters = suggestCodeClusters(highlights, { threshold })
    const ctxObj = (inputs.context ?? {}) as { members?: unknown }
    const original = new Set(Array.isArray(ctxObj.members) ? (ctxObj.members as string[]) : [])
    // Pick the regenerated cluster with the greatest overlap with the original.
    let best: { members: string[]; cohesion: number; overlap: number } = {
      members: [],
      cohesion: 0,
      overlap: -1,
    }
    for (const c of clusters) {
      const overlap = c.members.filter((m: string) => original.has(m)).length
      if (overlap > best.overlap) best = { members: c.members, cohesion: c.cohesion, overlap }
    }
    return { kind: 'code', members: best.members, cohesion: best.cohesion, status: 'draft' }
  }
}

export function registerRerun(program: Command): void {
  program
    .command('rerun')
    .description(
      'Rerun an AI/agent generation from its captured inputs. Default: verify the ' +
        'inputs are intact and reconstructable. --apply regenerates the output ' +
        '(deterministic agent artifacts; LLM regeneration not yet wired) and diffs it.',
    )
    .argument(
      '<ref>',
      'Event ULID, artifact id/prefix, human id (C-/H-/T-), or latest:<kind>=<seed>',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--apply', 'Regenerate and emit a new chained event (otherwise verify-only)')
    .option('--model <model>', 'Override the model for regeneration')
    .action(async (ref: string, flags: RerunFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const report = await rerunEvent(seedPath, {
          ref,
          apply: flags.apply === true,
          ...(flags.model !== undefined ? { modelOverride: flags.model } : {}),
          regenerate: makeDefaultRegenerator(seedPath),
          researcherId: defaultResearcherId(),
        })
        emit({ command: 'rerun', ...report }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
