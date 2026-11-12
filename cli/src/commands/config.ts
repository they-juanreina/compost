import { join } from 'node:path'
import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import {
  type ConfigValueType,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from '../lib/config.js'
import { resolveIdentity, SET_IDENTITY_COMMAND } from '../lib/identity.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { loadUserConfigRaw, saveUserConfigRaw, userConfigPath } from '../lib/userConfig.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ConfigFlags {
  seed?: string
  global?: boolean
}

const GLOBAL_HELP =
  'Use the global (per-user) config at ~/.compost/config.toml ($COMPOST_HOME) instead of the seed’s — e.g. user.email / user.name'

/** Where a config command reads/writes: the seed's .compost/config.toml, or
 * the global per-user file with --global. */
function target(flags: ConfigFlags): {
  scope: 'seed' | 'global'
  path: string
  seedPath?: string
  load: () => Record<string, unknown>
  save: (raw: Record<string, unknown>) => void
} {
  if (flags.global === true) {
    if (flags.seed !== undefined) {
      throw new CompostError('INVALID_INPUT', 'Pass either --global or --seed, not both.')
    }
    return {
      scope: 'global',
      path: userConfigPath(),
      load: () => loadUserConfigRaw(),
      save: (raw) => {
        saveUserConfigRaw(raw)
      },
    }
  }
  const seedPath = resolveSeedPath(process.cwd(), flags.seed)
  return {
    scope: 'seed',
    seedPath,
    path: join(seedPath, '.compost', 'config.toml'),
    load: () => loadConfig(seedPath).raw,
    save: (raw) => saveConfig(seedPath, raw),
  }
}

interface ConfigSetFlags extends ConfigFlags {
  type?: string
}

const VALID_TYPES: readonly ConfigValueType[] = ['string', 'bool', 'int', 'float', 'json']

function validateType(t: string | undefined): ConfigValueType {
  if (t === undefined) return 'string'
  if ((VALID_TYPES as readonly string[]).includes(t)) return t as ConfigValueType
  throw new CompostError(
    'INVALID_INPUT',
    `--type must be one of ${VALID_TYPES.join('|')}; got "${t}"`,
  )
}

export function registerConfig(program: Command): void {
  const cfg = program
    .command('config')
    .description(
      'Read or write values in the seed’s .compost/config.toml, or the global ~/.compost/config.toml with --global',
    )

  cfg
    .command('get')
    .description('Read a dotted key from config.toml')
    .argument('<key>')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .option('--global', GLOBAL_HELP)
    .action((key: string, flags: ConfigFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const t = target(flags)
        const value = getConfigValue(t.load(), key)
        emit(
          { status: 'ok', command: 'config get', scope: t.scope, key, value: value ?? null },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  cfg
    .command('set')
    .description('Write a dotted key into config.toml (default type: string)')
    .argument('<key>')
    .argument('<value>')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .option('--global', GLOBAL_HELP)
    .option(
      '--type <type>',
      'Value type: string (default) | bool | int | float | json. Strings need no flag; agents writing non-string values should pass --type explicitly.',
    )
    .action((key: string, value: string, flags: ConfigSetFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const type = validateType(flags.type)
        const t = target(flags)
        const raw = t.load()
        setConfigValue(raw, key, value, type)
        t.save(raw)
        const written = getConfigValue(raw, key)
        emit(
          {
            status: 'ok',
            command: 'config set',
            scope: t.scope,
            path: t.path,
            key,
            type,
            value: written,
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  cfg
    .command('show')
    .description(
      'Pretty-print the entire config.toml, plus the resolved researcher identity and where it came from',
    )
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .option('--global', GLOBAL_HELP)
    .action((flags: ConfigFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const t = target(flags)
        const identity = resolveIdentity({ seedPath: t.seedPath })
        emit(
          {
            status: 'ok',
            command: 'config show',
            scope: t.scope,
            path: t.path,
            config: t.load(),
            identity,
            ...(identity === null ? { identity_fix: SET_IDENTITY_COMMAND } : {}),
          },
          out,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
