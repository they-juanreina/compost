import type { Command } from 'commander'

import { CompostError, isCompostError } from '../errors.js'
import { HF_ALIASES, resolveSecret } from '../lib/secrets.js'
import { runSetup, type SetupCheck } from '../lib/setup.js'
import {
  actionsFor,
  type HfValidity,
  type RunItemResult,
  runItem,
  type SetupItemAction,
  validateHfToken,
} from '../lib/setupItem.js'
import { emit, emitError, getOutputOpts } from '../output.js'
import { glyphs } from '../render/glyphs.js'

/** Read all of stdin (the new token value, piped so it never lands in shell
 * history). Returns '' when stdin is an interactive TTY. (mirrors secrets.ts) */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Everything except `validate` changes state; only renew/set need a value. */
const READONLY = new Set(['validate'])
const NEEDS_VALUE = new Set(['renew', 'set'])

/**
 * Gate a `setup item run` invocation before it mutates anything. Extracted so
 * the (security-relevant) refusal logic is unit-testable without driving
 * commander: renew/set need a value (piped, so it stays out of shell history),
 * and any mutating action run non-interactively requires an explicit --yes.
 * `interactive` is the REAL terminal signal (`process.stdout.isTTY`), not the
 * `--human` output flag: `--human` is user/agent-forceable even when piped, so
 * gating on it would let an automated caller add `--human` to skip the --yes
 * confirmation. Throws INVALID_INPUT otherwise; returns void when the call may
 * proceed.
 */
export function assertRunAllowed(
  id: string,
  action: string,
  ctx: { interactive: boolean; yes: boolean; value: string },
): void {
  if (NEEDS_VALUE.has(action) && ctx.value === '') {
    throw new CompostError(
      'INVALID_INPUT',
      `Pipe the new value: \`printf %s "$TOKEN" | compost setup item run ${id} ${action}\` (keeps it out of shell history).`,
    )
  }
  if (!READONLY.has(action) && !ctx.interactive && ctx.yes !== true) {
    throw new CompostError(
      'INVALID_INPUT',
      `Refusing a mutating action non-interactively without --yes.`,
    )
  }
}

function glyph(status: SetupCheck['status']): string {
  const g = glyphs()
  return status === 'ok' ? g.ok : status === 'warn' ? g.warn : g.fail
}

/**
 * Register the `compost setup item …` group on the existing `setup` command.
 * This is the per-item maintenance surface: it has its OWN `command:'setup
 * item …'` JSON envelope, so the read-only `compost setup` report is untouched
 * byte-for-byte. The TTY wizard and the plugin skill are meant to wrap these
 * verbs rather than reimplement the behavior.
 */
export function registerSetupItem(setup: Command): void {
  const item = setup
    .command('item')
    .description(
      'Inspect and fix ONE setup prerequisite at a time — change/renew/revoke a token, re-validate a live credential, repair a single check.',
    )

  // setup item list — the directory of what's addressable + its actions.
  item
    .command('list')
    .description('List every setup item with its status and the lifecycle actions available on it.')
    .action(async (_flags: unknown, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        // Reuse the canonical runSetup probes (single source of truth) and
        // filter, rather than maintaining a separate per-id probe. It runs the
        // full check set — acceptable for an on-demand command; a dedicated
        // single-check probe is a future optimization, not a correctness need.
        const report = await runSetup({ cwd: process.cwd() })
        const items = report.checks.map((c) => ({
          id: c.id,
          label: c.label,
          status: c.status,
          actions: actionsFor(c.id),
        }))
        emit(
          { command: 'setup item list', schema_version: '1.0', items },
          out,
          (d: { items: typeof items }) =>
            d.items
              .map((it) => {
                const acts = it.actions.length
                  ? `  actions: ${it.actions.map((a) => a.id).join(', ')}`
                  : ''
                return `  ${glyph(it.status)} ${it.id.padEnd(28)} ${it.label}${acts}`
              })
              .join('\n'),
        )
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  // setup item show <id> [--validate] — re-probe ONE item; --validate adds the
  // live credential signal as a SEPARATE field (presence vs validity).
  item
    .command('show')
    .description(
      'Show one setup item: its presence status, fix, and actions. --validate adds a live credential probe.',
    )
    .argument('<id>', 'Stable check id, e.g. hf-token (see `setup item list`)')
    .option(
      '--validate',
      'Also probe whether a stored credential is LIVE (network; credential items only)',
    )
    .action(async (id: string, flags: { validate?: boolean }, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const report = await runSetup({ cwd: process.cwd() })
        const check = report.checks.find((c) => c.id === id)
        if (!check) {
          throw new CompostError(
            'INVALID_INPUT',
            `Unknown item "${id}". Run \`compost setup item list\` for valid ids.`,
          )
        }
        const actions = actionsFor(id)
        let live: HfValidity | undefined
        if (flags.validate === true && id === 'hf-token') {
          const found = resolveSecret('HUGGINGFACE_TOKEN', { aliases: HF_ALIASES })
          live = found
            ? await validateHfToken(found.value)
            : { status: 'fail', detail: 'no token set to validate' }
        }
        emit(
          { command: 'setup item show', id, check, actions, ...(live ? { live } : {}) },
          out,
          (d: { check: SetupCheck; actions: SetupItemAction[]; live?: HfValidity }) => {
            const lines = [`${d.check.label} [${d.check.status}] — ${d.check.detail}`]
            if (d.check.fix) lines.push(`  fix: ${d.check.fix}`)
            if (d.live) lines.push(`  live: ${d.live.status} — ${d.live.detail}`)
            if (d.actions.length)
              lines.push(`  actions: ${d.actions.map((a) => `${a.id} (${a.side})`).join(', ')}`)
            return lines.join('\n')
          },
        )
        if (check.status === 'fail' || live?.status === 'fail') process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })

  // setup item run <id> <action> [--yes] — the generic mutation primitive.
  item
    .command('run')
    .description('Run one lifecycle action on one item, e.g. `setup item run hf-token renew`.')
    .argument('<id>', 'Stable check id, e.g. hf-token, model:bge-m3, secret-perms:<path>')
    .argument('<action>', 'validate | renew | forget | pull | fix')
    .option(
      '-y, --yes',
      'Confirm a mutating action when not at a TTY (required for --json / piped use)',
    )
    .action(async (id: string, action: string, flags: { yes?: boolean }, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const value = NEEDS_VALUE.has(action) ? (await readStdin()).trim() : ''
        assertRunAllowed(id, action, {
          // Real terminal, not the forceable --human flag (see assertRunAllowed).
          interactive: process.stdout.isTTY === true,
          yes: flags.yes === true,
          value,
        })
        const result = await runItem(id, action, value ? { value } : {})
        emit(
          { command: 'setup item run', ...result },
          out,
          (d: RunItemResult) => `${d.id} ${d.action}: ${d.recheck.status} — ${d.recheck.detail}`,
        )
        if (result.recheck.status === 'fail') process.exitCode = 1
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
