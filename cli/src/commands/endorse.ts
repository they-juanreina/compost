import type { Command } from 'commander'
import { isCompostError } from '../errors.js'
import { endorseArtifact } from '../lib/artifacts.js'
import { resolveResearcherId } from '../lib/identity.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface EndorseFlags {
  seed?: string
  researcher?: string
}

export function registerEndorse(program: Command): void {
  program
    .command('endorse')
    .description(
      'Endorse an AI-suggested artifact — promotes it from [draft] to researcher-approved',
    )
    .argument(
      '<artifact-ref>',
      'Id from `compost create` (C-slug / H-NNN / T-slug), SHA256 prefix, or latest:<kind>=<seed>',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option(
      '--researcher <id>',
      'Researcher identity (default: $COMPOST_USER, then user.email in compost config, then git)',
    )
    .action((artifactRef: string, flags: EndorseFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const researcher = resolveResearcherId({ explicit: flags.researcher, seedPath })
        const result = endorseArtifact(seedPath, artifactRef, researcher)
        // A second endorse by the same researcher is a no-op (#169) — surface
        // that distinctly so callers/scripts can tell "ok, just did it" from
        // "ok, was already endorsed" without parsing event ids.
        const status = result.already_endorsed === true ? 'already_endorsed' : 'ok'
        emit({ status, command: 'endorse', researcher, ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
