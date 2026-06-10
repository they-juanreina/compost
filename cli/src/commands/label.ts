import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { labelSession, type SpeakerMap, type SpeakerType } from '../lib/speakers.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface LabelFlags {
  seed?: string
  map: string
  type?: string
}

const TYPES: SpeakerType[] = ['moderator', 'participant', 'other']

/** Parse `id=value,id=value` into a record; first `=` splits, so values may
 * contain `=` but not `,`. */
function parsePairs(raw: string, what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      throw new CompostError('INVALID_INPUT', `--${what} entry must be id=value (got "${trimmed}")`)
    }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  if (Object.keys(out).length === 0) {
    throw new CompostError('INVALID_INPUT', `--${what} had no id=value pairs`)
  }
  return out
}

export function registerLabel(program: Command): void {
  program
    .command('label')
    .description(
      'Map diarized speaker cluster ids to real names (#177). Persists to a sidecar ' +
        'so names survive re-transcription. e.g. --map S0=Juan,S1=P07',
    )
    .argument('<session-id>', 'Session id (e.g. S001)')
    .requiredOption('--map <pairs>', 'Comma-separated clusterId=Name pairs')
    .option('--type <pairs>', 'Comma-separated clusterId=moderator|participant|other pairs')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .action((sessionId: string, flags: LabelFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const names = parsePairs(flags.map, 'map')
        const map: SpeakerMap = {}
        for (const [id, name] of Object.entries(names)) map[id] = { name }
        if (flags.type !== undefined) {
          for (const [id, t] of Object.entries(parsePairs(flags.type, 'type'))) {
            if (!TYPES.includes(t as SpeakerType)) {
              throw new CompostError(
                'INVALID_INPUT',
                `--type for ${id} must be one of ${TYPES.join('|')} (got "${t}")`,
              )
            }
            map[id] = { ...map[id], type: t as SpeakerType }
          }
        }
        const result = labelSession(seedPath, sessionId, map)
        emit(
          {
            status: 'ok',
            command: 'label',
            session: result.session,
            relabeled: result.applied,
            unmatched: result.unmatched,
            sidecar: result.sidecar_path,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
