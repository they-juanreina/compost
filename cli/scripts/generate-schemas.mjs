#!/usr/bin/env node
/**
 * Embed schema/*.json files as a TypeScript module the CLI imports directly.
 *
 * Without this, validate.ts resolves schemas via a relative filesystem path
 * (cli/dist/lib/validate.js → ../../../schema). That works in the workspace
 * but breaks when the CLI is published standalone or installed as a global
 * binary — the schemas live at the repo root, not inside the package.
 *
 * Strategy: at build time we read each schema/*.json and emit a
 * `schemas.generated.ts` that exports them as typed constants. The TS
 * compiler then bundles them into dist/lib/schemas.generated.js with the
 * other code.
 *
 * Run via `pnpm --filter compost-cli run build` (wired in package.json's
 * `build` script as a prebuild step).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = join(__dirname, '..', '..', 'schema')
const OUTPUT = join(__dirname, '..', 'src', 'lib', 'schemas.generated.ts')

const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json')).sort()

const banner = `/**
 * GENERATED — DO NOT EDIT. Run \`pnpm --filter compost-cli run build\` to regenerate.
 *
 * Embeds every schema/*.json file as a typed constant so validate.ts can use
 * them without filesystem IO. The CLI can be published standalone without
 * the schema/ tree because the schemas are now part of the compiled bundle.
 */
`

const exports = []
for (const f of files) {
  const json = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'))
  // toUpperCase + replace .json + replace . with _ → e.g. transcript.schema.json
  // becomes TRANSCRIPT_SCHEMA
  const name = f
    .replace(/\.json$/, '')
    .replace(/\./g, '_')
    .toUpperCase()
  exports.push(
    `export const ${name}: Record<string, unknown> = ${JSON.stringify(json, null, 2)}`,
  )
}

const body =
  banner +
  '\n' +
  '/* eslint-disable */\n' +
  exports.join('\n\n') +
  '\n\n' +
  `export const ALL_SCHEMAS: Record<string, Record<string, unknown>> = {\n` +
  files.map((f) => `  ${JSON.stringify(f)}: ${f.replace(/\.json$/, '').replace(/\./g, '_').toUpperCase()},`).join('\n') +
  '\n}\n'

writeFileSync(OUTPUT, body, 'utf8')
process.stderr.write(`generated ${OUTPUT} from ${files.length} schemas\n`)
