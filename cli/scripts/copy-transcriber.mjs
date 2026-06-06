#!/usr/bin/env node
/**
 * Bundle the Python transcriber source into the cli package (#206).
 *
 * The native (host) transcription path shells out to `python -m app.transcribe_cli`
 * with cwd set to the transcriber/ dir. In the workspace, cli/ and transcriber/
 * are siblings and `findRepoTranscriberDir` (src/lib/nativeRuntime.ts) walks up to
 * find the repo-root transcriber/. But a standalone/global install
 * (`npm i -g @they-juanreina/compost-cli`) has no sibling transcriber/, so native
 * transcription couldn't resolve the Python package and fell back to Docker —
 * the bug in #206.
 *
 * Fix (same shape as generate-schemas.mjs, which materializes repo-root schemas
 * into the package): copy transcriber/app/** + pyproject.toml into cli/transcriber/
 * so they ship in the published tarball. In an installed package the walk-up then
 * finds <pkgroot>/transcriber/app/transcribe_cli.py one level up from dist/.
 *
 * Wired into cli's `prepack` (NOT `prebuild`) so it materializes immediately
 * before `pnpm publish`/`pnpm pack` packs the tarball, but never exists during
 * normal `pnpm build`/`pnpm test` — which keeps the generated copy from shadowing
 * the canonical repo-root transcriber/ in dev. The dir is gitignored.
 *
 * Only app/** + pyproject.toml are copied (pyproject is the existence-guard
 * provisionNative.ts checks). __pycache__/.pyc and tool caches are filtered so
 * the tarball never ships compiled bytecode or the multi-GB .venv. A release-job
 * assertion greps the packed tarball to fail loudly if this ever regresses.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Env overrides exist so the unit test can drive the real script against temp
// dirs; production runs use the package-relative defaults.
const SRC = process.env.COPY_TRANSCRIBER_SRC || join(__dirname, '..', '..', 'transcriber')
const DEST = process.env.COPY_TRANSCRIBER_DEST || join(__dirname, '..', 'transcriber')

// Python bytecode + tool caches must never enter the tarball.
const EXCLUDE = /(^|[\\/])(__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache)([\\/]|$)/

const sentinel = join(DEST, 'app', 'transcribe_cli.py')

if (!existsSync(SRC)) {
  // Building outside the monorepo (e.g. from an already-bundled package): keep an
  // existing bundle if present, otherwise fail loudly rather than ship nothing.
  if (existsSync(sentinel)) {
    process.stderr.write(
      `copy-transcriber: source ${SRC} absent; kept existing bundle at ${DEST}\n`,
    )
  } else {
    process.stderr.write(
      `copy-transcriber: ERROR source ${SRC} not found and no bundle at ${DEST}\n`,
    )
    process.exit(1)
  }
} else {
  // Clean first so a removed/renamed app module never lingers in the bundle.
  rmSync(DEST, { recursive: true, force: true })
  mkdirSync(DEST, { recursive: true })
  cpSync(join(SRC, 'app'), join(DEST, 'app'), {
    recursive: true,
    filter: (src) => !EXCLUDE.test(src + sep) && !src.endsWith('.pyc'),
  })
  copyFileSync(join(SRC, 'pyproject.toml'), join(DEST, 'pyproject.toml'))
  process.stderr.write(`copy-transcriber: bundled app/ + pyproject.toml → ${DEST}\n`)
}
