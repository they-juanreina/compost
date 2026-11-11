import type { Command } from 'commander'
import { isCompostError } from '../errors.js'
import { defaultResearcherId, rejectArtifact } from '../lib/artifacts.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface RejectFlags {
  seed?: string
  researcher?: string
  note?: string
}

export function registerReject(program: Command): void {
  program
    .command('reject')
    .description(
      'Reject an artifact — archives it (never deletes) and records a researcher reject event',
    )
    .argument(
      '<artifact-ref>',
      'Id from `compost create` (C-slug / H-NNN / T-slug), SHA256 prefix, or latest:<kind>=<seed>',
    )
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--researcher <id>', 'Researcher identity (default: $COMPOST_USER)')
    .option('--note <text>', 'Why it was rejected (kept on the reject event for audit)')
    .action((artifactRef: string, flags: RejectFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const researcher = flags.researcher ?? defaultResearcherId()
        const result = rejectArtifact(seedPath, artifactRef, researcher, flags.note)
        // A second reject by the same researcher is a no-op — surface that
        // distinctly, mirroring endorse's `already_endorsed` (#169).
        const status = result.already_rejected === true ? 'already_rejected' : 'ok'
        emit({ status, command: 'reject', researcher, ...result }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
