import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { getConfigValue, loadConfig, saveConfig, setConfigValue } from '../lib/config.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ConfigFlags {
  seed?: string
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
    .description('Write a dotted key into config.toml')
    .argument('<key>')
    .argument('<value>')
    .option('--seed <name>', 'Target seed (defaults to the only seed under ./Seeds)')
    .action((key: string, value: string, flags: ConfigFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const config = loadConfig(seedPath)
        setConfigValue(config.raw, key, value)
        saveConfig(seedPath, config.raw)
        const written = getConfigValue(config.raw, key)
        emit({ status: 'ok', command: 'config set', key, value: written }, out)
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
