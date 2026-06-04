import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import {
  type ConfigValueType,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from '../lib/config.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ConfigFlags {
  seed?: string
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
  const cfg = program.command('config').description('Read or write values in .compost/config.toml')

  cfg
    .command('get')
    .description('Read a dotted key from config.toml')
    .argument('<key>')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .action((key: string, flags: ConfigFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const config = loadConfig(seedPath)
        const value = getConfigValue(config.raw, key)
        emit({ status: 'ok', command: 'config get', key, value: value ?? null }, out)
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
    .option(
      '--type <type>',
      'Value type: string (default) | bool | int | float | json. Strings need no flag; agents writing non-string values should pass --type explicitly.',
    )
    .action((key: string, value: string, flags: ConfigSetFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const type = validateType(flags.type)
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const config = loadConfig(seedPath)
        setConfigValue(config.raw, key, value, type)
        saveConfig(seedPath, config.raw)
        const written = getConfigValue(config.raw, key)
        emit({ status: 'ok', command: 'config set', key, type, value: written }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  cfg
    .command('show')
    .description('Pretty-print the entire config.toml')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .action((flags: ConfigFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const config = loadConfig(seedPath)
        emit({ status: 'ok', command: 'config show', config: config.raw }, out)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
