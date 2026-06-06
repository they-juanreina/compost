import { Command } from 'commander'

import { registerBlame } from './commands/blame.js'
import { registerChat } from './commands/chat.js'
import { registerCode } from './commands/code.js'
import { registerConfig } from './commands/config.js'
import { registerCreate } from './commands/create.js'
import { registerEndorse } from './commands/endorse.js'
import { registerEvals } from './commands/evals.js'
import { registerExport } from './commands/export.js'
import { registerIngest } from './commands/ingest.js'
import { registerInit } from './commands/init.js'
import { registerMigrate } from './commands/migrate.js'
import { registerModels } from './commands/models.js'
import { registerQuery } from './commands/query.js'
import { registerReindex } from './commands/reindex.js'
import { registerRescan } from './commands/rescan.js'
import { registerSaturate } from './commands/saturate.js'
import { registerSearch } from './commands/search.js'
import { registerServe } from './commands/serve.js'
import { registerSession } from './commands/session.js'
import { registerSetup } from './commands/setup.js'
import { registerSnap } from './commands/snap.js'
import { registerStatus } from './commands/status.js'
import { registerSynthesize } from './commands/synthesize.js'
import { registerTag } from './commands/tag.js'
import { registerTranscribe } from './commands/transcribe.js'
import { registerValidate } from './commands/validate.js'
import { registerWatch } from './commands/watch.js'

const VERSION = '0.1.1'

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('compost')
    .description('Local-first, AI-first research analysis harness for coding agents and humans.')
    .version(VERSION, '-V, --version')
    .option(
      '--human',
      'Pretty-print output for human eyes (JSON is the default — agents parse it directly).',
    )
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true })

  registerInit(program)
  registerIngest(program)
  registerTranscribe(program)
  registerWatch(program)
  registerSnap(program)
  registerStatus(program)
  registerBlame(program)
  registerMigrate(program)
  registerExport(program)
  registerReindex(program)
  registerRescan(program)
  registerSaturate(program)
  registerValidate(program)
  registerTag(program)
  registerCode(program)
  registerSynthesize(program)
  registerSearch(program)
  registerSession(program)
  registerCreate(program)
  registerEndorse(program)
  registerSetup(program)
  registerQuery(program)
  registerChat(program)
  registerServe(program)
  registerModels(program)
  registerEvals(program)
  registerConfig(program)

  return program
}
