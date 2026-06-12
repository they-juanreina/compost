import { Command } from 'commander'

import { registerAgreement } from './commands/agreement.js'
import { registerBackup } from './commands/backup.js'
import { registerBlame } from './commands/blame.js'
import { registerCategory } from './commands/category.js'
import { registerChat } from './commands/chat.js'
import { registerCode } from './commands/code.js'
import { registerCodebook } from './commands/codebook.js'
import { registerConfig } from './commands/config.js'
import { registerCreate } from './commands/create.js'
import { registerEndorse } from './commands/endorse.js'
import { registerEvals } from './commands/evals.js'
import { registerExport } from './commands/export.js'
import { registerImport } from './commands/import.js'
import { registerIngest } from './commands/ingest.js'
import { registerInit } from './commands/init.js'
import { registerJobs } from './commands/jobs.js'
import { registerLabel } from './commands/label.js'
import { registerMigrate } from './commands/migrate.js'
import { registerModels } from './commands/models.js'
import { registerQuery } from './commands/query.js'
import { registerRecode } from './commands/recode.js'
import { registerReindex } from './commands/reindex.js'
import { registerRerun } from './commands/rerun.js'
import { registerRescan } from './commands/rescan.js'
import { registerSaturate } from './commands/saturate.js'
import { registerSearch } from './commands/search.js'
import { registerSecrets } from './commands/secrets.js'
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
import { currentCliVersion } from './lib/version.js'

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('compost')
    .description('Local-first, AI-first research analysis harness for coding agents and humans.')
    // Single source of truth: read from package.json (drops a file from the
    // version-bump checklist; no more hardcoded literal to drift).
    .version(currentCliVersion(), '-V, --version')
    .option(
      '--human',
      'Force human-readable output (auto-on at a TTY; JSON when piped or called by an agent).',
    )
    .option('--json', 'Force machine-readable JSON output (overrides TTY auto-detection).')
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: true })
    .addHelpText(
      'after',
      `
Quick start:
  $ compost init my-study                                   scaffold Seeds/my-study/
  $ printf %s "$HF_TOKEN" | compost secrets set HUGGINGFACE_TOKEN   store a token (not in shell history)
  $ compost ingest ./recording.m4a --seed my-study          queue audio for transcription
  $ compost watch --once --seed my-study                    drain the ingest/transcribe/embed queue
  $ compost search "trust" --seed my-study                  retrieve grounded passages

Output is human-readable at a TTY and JSON when piped or called by an agent (force with --json / --human).`,
    )

  registerInit(program)
  registerIngest(program)
  registerImport(program)
  registerTranscribe(program)
  registerLabel(program)
  registerWatch(program)
  registerJobs(program)
  registerSnap(program)
  registerStatus(program)
  registerBlame(program)
  registerMigrate(program)
  registerExport(program)
  registerBackup(program)
  registerReindex(program)
  registerRescan(program)
  registerSaturate(program)
  registerValidate(program)
  registerTag(program)
  registerCode(program)
  registerCodebook(program)
  registerCategory(program)
  registerRecode(program)
  registerAgreement(program)
  registerRerun(program)
  registerSynthesize(program)
  registerSearch(program)
  registerSecrets(program)
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
