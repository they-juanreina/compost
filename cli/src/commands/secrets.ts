import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import {
  HF_ALIASES,
  listSecrets,
  type RmResult,
  resolveSecret,
  rmSecret,
  type SecretListing,
  type SetResult,
  setSecret,
} from '../lib/secrets.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { glyphs } from '../render/glyphs.js'

/** Aliases to also check when resolving a given primary name. */
function aliasesFor(name: string): string[] {
  return name === 'HUGGINGFACE_TOKEN' ? HF_ALIASES : []
}

/** Read all of stdin (for `secrets set <name>` with the value piped in, so it
 * never lands in shell history). Returns '' if stdin is an interactive TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** True when the user explicitly forced JSON with the root `--json` flag. */
function jsonExplicit(cmd: Command): boolean {
  let root: Command = cmd
  while (root.parent) root = root.parent
  return (root.opts() as { json?: boolean }).json === true
}

export function registerSecrets(program: Command): void {
  const secrets = program
    .command('secrets')
    .description(
      'Store and resolve user secrets (HuggingFace token, LLM API keys). Precedence: env var > OS keychain > ~/.compost/secrets.env (0600).',
    )

  secrets
    .command('set')
    .description(
      'Store a secret in the OS keychain (or a 0600 ~/.compost/secrets.env fallback). Pipe the value via stdin to keep it out of shell history.',
    )
    .argument('<name>', 'Env-var-shaped name, e.g. HUGGINGFACE_TOKEN')
    .argument('[value]', 'Secret value; omit to read from stdin')
    .addHelpText(
      'after',
      '\nExamples (pipe via stdin to keep the value out of shell history):\n  $ printf %s "$HF_TOKEN" | compost secrets set HUGGINGFACE_TOKEN\n  $ compost secrets list        # shows names + where each is stored, never values',
    )
    .action(async (name: string, value: string | undefined, _flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // An inline value lands in shell history — nudge toward the stdin pipe.
        if (value !== undefined && process.stdin.isTTY === true) {
          process.stderr.write(
            'warning: passing the value inline puts it in your shell history. Prefer: printf %s "$TOKEN" | compost secrets set NAME\n',
          )
        }
        const raw = value ?? (await readStdin())
        const secret = raw.trim()
        if (secret === '') {
          if (out.human)
            process.stderr.write(
              'No value provided. Pass it as an argument or pipe it: `printf %s "$TOKEN" | compost secrets set NAME`\n',
            )
          throw new CompostError('INVALID_INPUT', `No value provided for ${name}.`)
        }
        const result = setSecret(name, secret)
        emit(
          { status: 'ok', command: 'secrets set', ...result },
          out,
          (d: SetResult) =>
            `Stored ${d.name} in ${
              d.stored_in === 'keychain' ? d.location : `${d.location} (0600)`
            }.${d.fallback_reason ? `\n  (keychain unavailable: ${d.fallback_reason} — used the file fallback)` : ''}`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  secrets
    .command('get')
    .description(
      'Resolve a secret (env > keychain > secrets.env) and print its value to stdout. Exits non-zero if unset.',
    )
    .argument('<name>')
    .action((name: string, _flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const resolved = resolveSecret(name, { aliases: aliasesFor(name) })
        if (!resolved) {
          if (jsonExplicit(cmd)) {
            process.stdout.write(
              `${JSON.stringify({ status: 'not_found', command: 'secrets get', name, value: null, source: null })}\n`,
            )
          } else if (out.human) {
            process.stderr.write(`${name} is not set (checked env, keychain, secrets.env)\n`)
          }
          process.exitCode = 1
          return
        }
        if (jsonExplicit(cmd)) {
          emit(
            {
              status: 'ok',
              command: 'secrets get',
              name,
              source: resolved.source,
              value: resolved.value,
            },
            out,
          )
          return
        }
        // Default: raw value on stdout so `$(compost secrets get NAME)` works in
        // any context; the source goes to stderr (human mode only).
        process.stdout.write(`${resolved.value}\n`)
        if (out.human) process.stderr.write(`source: ${resolved.source}\n`)
        // Footgun guard: at an interactive terminal the value is now in
        // scrollback. Warn on stderr (never affects the stdout value capture).
        if (process.stdout.isTTY === true) {
          process.stderr.write(
            'warning: the secret value was printed to your terminal (now in scrollback). Pipe/capture it instead of reading it on a shared screen.\n',
          )
        }
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  secrets
    .command('rm')
    .alias('remove')
    .description(
      'Remove a secret from the keychain and secrets.env (env vars are your shell — unset those yourself).',
    )
    .argument('<name>')
    .action((name: string, _flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const result = rmSecret(name)
        emit({ status: 'ok', command: 'secrets rm', ...result }, out, (d: RmResult) =>
          d.removed_from.length === 0
            ? `${d.name}: nothing stored in keychain or secrets.env.`
            : `Removed ${d.name} from ${d.removed_from.join(' and ')}.`,
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  secrets
    .command('list')
    .alias('ls')
    .description('List which secrets are set and where (never prints values).')
    .action((_flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const { items, file } = listSecrets()
        emit(
          {
            status: 'ok',
            command: 'secrets list',
            items,
            secrets_env: file.path,
            secrets_env_secure: file.secure,
          },
          out,
          (d: { items: SecretListing[]; secrets_env: string; secrets_env_secure: boolean }) => {
            if (d.secrets_env_secure && d.items.length === 0)
              return 'No secrets set (checked env, keychain, secrets.env).'
            const lines = d.items.map(
              (it: SecretListing) => `  ${it.name.padEnd(20)} ${it.sources.join(', ')}`,
            )
            const warn = d.secrets_env_secure
              ? ''
              : `\n${glyphs().warn} ${d.secrets_env} is group/world-readable and is being ignored — fix: chmod 600 ${d.secrets_env}`
            return `Secrets (name → source; values never shown):\n${lines.join('\n')}${warn}`
          },
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
