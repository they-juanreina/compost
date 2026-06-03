import type { Command } from 'commander'

import { stubAction } from './_stub.js'

export function registerConfig(program: Command): void {
  const cfg = program.command('config').description('Read or write values in .compost/config.toml')

  cfg
    .command('get')
    .description('Read a dotted key from config.toml')
    .argument('<key>')
    .action(stubAction({ command: 'config get' }))

  cfg
    .command('set')
    .description('Write a dotted key into config.toml')
    .argument('<key>')
    .argument('<value>')
    .action(stubAction({ command: 'config set' }))
}
