# Changelog

## Unreleased

Deepens provenance from an audit trail into a reproducibility + agreement layer.
See [docs/provenance-deepening-design.md](docs/provenance-deepening-design.md).

### Added

- **`compost setup` is now a guided wizard at a terminal.** Each missing
  prerequisite becomes a per-step confirmed fix — install/start Ollama, pull
  `bge-m3`, provision the native transcription engine (or start the Docker
  fallback with the correct bundled path), paste the HuggingFace token (hidden
  input, stored in the OS keychain, both pyannote licenses verified on the
  spot), and choose how `compost chat` runs: a local Ollama model (pulled for
  you) or an Anthropic API key. Choices are saved to a user-level
  `~/.compost/config.toml` that `compost init` overlays onto every new seed's
  routing, and the wizard offers to update existing seeds. Piped/`--json`/
  `--check` invocations keep the read-only diagnostic exactly as before.
- **Documents auto-link into their sessions (#246).** The legacy worker now
  writes the normalized document as `sessions/SXXX/transcript.json` (with the
  session's real id and a rendered `transcript.md`) and names the `legacy/`
  copy after the researcher's original filename — no more `legacy/source.json`
  collisions and no more manual `cp` step in the first-study walkthrough. An
  existing transcript is never overwritten.
- **`providers.<name>.timeout_ms` config + a real timeout error.** Large local
  models can need more than the 120s default just to load; the per-provider
  timeout is now configurable, and an Ollama timeout reports which model
  stalled and the two ways out instead of a bare "operation was aborted".

- **`compost jobs` + `compost jobs requeue` — dead-letter queue visibility
  (#239).** A job that burns its 3 attempts parks as permanently `failed` and
  the watcher skips it; previously nothing listed it, nothing could revive it,
  `watch --once` reported `ok` over the dead queue, and `status` showed the
  session as `queued` forever. Now `compost jobs` lists the queue with last
  errors, `compost jobs requeue [--id N]` resets failed jobs with a fresh
  attempt budget (warning when a job's source file no longer exists on disk —
  #240), `watch` surfaces given-up jobs as a failure (non-zero exit, with the
  recovery command), and `status` warns per seed.
- **`compost init` warns when run inside a folder named `Seeds` (#241).** Init
  always scaffolds `<cwd>/Seeds/<name>`, so running it from inside a Seeds
  folder silently nests `Seeds/Seeds/` — a first-run foot-gun that, combined
  with hand-moving the seed afterwards, strands the job queue. Behavior is
  unchanged; the output now carries a `warnings[]` entry naming both paths.
- **Content-addressed input persistence.** Migration `0003` adds an `ai_inputs`
  table and a nullable `events.input_id` FK. AI/agent generations now persist the
  reconstructable bundle (model, params, system prompt, prompt, context) that
  produced them — not just the one-way `prompt_hash`. Captured automatically for
  internal calls (the similarity-scanner) and best-effort for host-agent creates
  via `compost create --inputs-file`. Backfill is impossible (pre-migration events
  carry `input_id = NULL`).
- **`compost rerun <ref>`.** Verify (default) confirms a generation's captured
  inputs are intact and reconstructable; `--apply` regenerates the output, emits a
  chained `update` event, and diffs the payloads. Deterministic agent artifacts
  re-cluster provider-free; LLM regeneration is deferred. Plus a `compost_rerun`
  MCP tool.
- **`compost agreement` — human↔machine intercoder agreement.** Cohen's κ +
  Krippendorff's nominal α over highlights coded by BOTH a blind researcher and the
  machine, with per-code and pooled scores and a Landis–Koch band. Reports
  `insufficient` below `--min-units` (κ on a few items is noise). The blind
  researcher codings come from **`compost recode`** (intentionally CLI/human-only —
  not an agent tool, so an agent can't fabricate the comparison side). Read-only
  `compost_agreement` MCP tool.
- **`compost export --format prov`.** W3C PROV JSON-LD serialization of the event
  log using the PROV-AGENT vocabulary (arXiv:2508.02866): artifact→Entity,
  event→Activity, actor→Agent (`ai`→`provagent:AIAgent`), `parent_event`→
  `wasInformedBy`; an AI event is a `provagent:AIModelInvocation` that `prov:used` a
  `provagent:Prompt` (captured input bundle) + `provagent:AIModel`, generating
  `provagent:ResponseData`; a deterministic agent → `provagent:AgentTool`. Because
  inputs are now persisted, an AI invocation expresses its real inputs, not an
  opaque hash. Extended `compost_export` MCP tool.
- **`compost secrets set|get|rm|list` — secure-by-default token storage.** A
  documented resolution precedence for the HuggingFace token and LLM provider
  keys: environment variable > OS keychain (macOS `security` / Linux
  `secret-tool` — shelled out, **zero new dependencies**) > `~/.compost/secrets.env`
  (a `0600`-enforced dotenv). `set` reads the value from stdin (kept out of shell
  history); `list` shows where each secret lives but never the value. The dotenv
  is auto-loaded into the environment at startup so file-stored secrets resolve
  everywhere an env var would, without editing a shell profile — and an insecure
  (group/world-readable) `secrets.env` is *refused, not read*.

### Fixed

- **`compost setup` no longer reports `ready: true` on a machine that cannot
  ingest anything (#242).** When neither the native runtime nor the Docker
  transcriber is available, a derived `ingest-engine` check fails (audio AND
  document ingest both require the engine); either engine alone satisfies it.

### Security

- **`compost setup` now audits secret-file permissions.** Warns (non-blocking,
  with the exact `chmod`) when a group/world-readable secret file is found under
  `~/.compost` — including hand-rolled files like a `644 ~/.compost/hf_token/…`.
  `compost secrets set` always writes `0600` files in a `0700` `~/.compost`.
- **HF token resolution mirrors the LLM-key model.** `setup`, native
  transcription, and every command now resolve `HUGGINGFACE_TOKEN`/`HF_TOKEN` by
  the env > keychain > `0600`-dotenv precedence instead of env-only — so users no
  longer hand-roll insecure token files. New SECURITY.md "Storing your tokens"
  section documents the hierarchy, the hard rule (secrets never in `Seeds/` or
  `config.toml`; only the env-var *name* in `api_key_env`), and multi-user
  guidance.

## v0.1.2 — 2026-06-06

Native transcription now works on a plain global install, the release pipeline
moved to npm Trusted Publishing (OIDC), and the biome lint debt is cleared.

### Fixed

- **Global installs transcribe natively — no `COMPOST_TRANSCRIBER_DIR` needed
  (#206).** `npm i -g @they-juanreina/compost-cli` shipped no Python transcriber
  source, so native ASR couldn't resolve the package and fell back to Docker
  (which surfaced as `transcriber service unreachable at :7862`). The cli tarball
  now bundles `transcriber/app` + `pyproject.toml` via a `prepack` step (mirroring
  the schema-bundling precedent); the existing resolver finds it one level up from
  `dist/`. The copy is generated only at pack time so it never shadows the repo
  source in dev, and is filtered to exclude `.venv` / `__pycache__` / caches — a
  release-job assertion fails the build if the source ever stops shipping or cruft
  sneaks in. The `compost setup` doctor no longer reports the old #206 limitation
  or tells you to set `COMPOST_TRANSCRIBER_DIR` (still honored as an override).

### Changed

- **npm publishing moved to Trusted Publishing (OIDC) (#208).** The release job
  no longer carries a long-lived `NPM_TOKEN`; GitHub Actions exchanges a
  short-lived OIDC token for publish credentials at runtime and attaches a
  verifiable provenance attestation to each tarball (`npm audit signatures`).
  Closes the remaining accepted risk from the v0.1.0 security audit.

### Internal

- Cleared the biome lint debt (85 warnings → 0): safe narrowing or a justified
  `// biome-ignore` for genuine non-null-assertion invariants (DP-table indices,
  equal-length-vector loops), plus dead-code removal. No behavior change (#225).

## v0.1.1 — 2026-06-05

Security + UX patch. Five fixes landed since v0.1.0; bundle them into one
release so `npm i -g @they-juanreina/compost-cli@latest` picks them up.

A multi-dimension security audit ran on v0.1.0 (see
[SECURITY.md](SECURITY.md) → "v0.1.0 security audit"). It produced 27 raw
findings, 5 confirmed after two-lens adversarial verification; the three
actionable ones are fixed here.

### Security

- **HIGH — pin third-party Actions to SHAs (#210).** `softprops/action-gh-release@v2`
  and `pnpm/action-setup@v4` co-resided with `NPM_TOKEN` in the release job.
  Same attack class as `tj-actions/changed-files` (Mar 2024) and
  `reviewdog/action-setup` (Mar 2025) — an upstream maintainer compromise
  could repoint a `vN` tag and exfil the npm token. Every `uses:` line
  in `.github/workflows/*` now pins a 40-char commit SHA, including first-party
  `actions/*`. New `.github/dependabot.yml` watches the `github-actions`
  ecosystem and PRs grouped upgrades weekly.
- **MEDIUM — `--seed` path-traversal (#211).** `resolveSeedPath` did
  `join(root, seed)` with no validation. `--seed '../../foo'` resolved
  outside `Seeds/`, and every seed-scoped command (highlight/code/theme/
  endorse/ingest/transcribe/chat/tag/search/saturate) wrote there. Two-layer
  defense added: deny-list for `/`, `\`, `..`, absolute paths, and empty;
  plus a post-resolve containment check that asserts the path stays under
  `<cwd>/Seeds/`. Legacy seed names with spaces or uppercase keep working.
- **LOW — ingest symlink-following (#212).** `walk()` used `statSync` (follows
  symlinks); a tarball with a subdir symlinked to `~/.ssh` or `/var/log`
  silently traversed those destinations and queued arbitrary files for
  ingest. Switched to `lstatSync` and surfaced any skipped symlinks on
  `IngestResult.symlinks_skipped` so they don't silently disappear.

The audit's two **accepted risks** are unchanged: `better-sqlite3`'s
prebuild binary fetch (TLS-only integrity) and the `NPM_TOKEN` long-lived
secret (closed by [#208](https://github.com/they-juanreina/compost/issues/208)
when we migrate to Trusted Publishing).

### UX

- **`compost setup` distinguishes venv vs transcriber-source gaps (#207).**
  Pre-fix the doctor reported "no native venv resolved" even when the venv
  existed — `resolveNativeRuntime` returns null on either missing piece. New
  `diagnoseNativeRuntime` returns each piece independently. The doctor now
  branches: "managed venv missing" (suggests `--provision-native`) vs
  "venv ready, but transcriber source not resolved" (suggests
  `COMPOST_TRANSCRIBER_DIR` or the Docker fallback; cross-references the
  open [#206](https://github.com/they-juanreina/compost/issues/206)).

### Release infra

- **Prereleases publish under the `rc` npm dist-tag (#209).** `v*-rc.N`
  tags now publish with `pnpm publish --tag rc` so they don't claim
  `latest`. Stable tags roll `latest` as usual.
- **SECURITY.md** added (also part of this release): threat model, reporting
  channel, supported-version policy, v0.1.0 audit summary, accepted risks,
  user hardening notes.

### Known limitations (unchanged from v0.1.0)

The global npm install still doesn't include the transcriber Python source —
native ASR on a `npm i -g` install needs `COMPOST_TRANSCRIBER_DIR` set to a
repo clone, or fall back to Docker. Tracked at
[#206](https://github.com/they-juanreina/compost/issues/206); the doctor
now gives the right diagnostic.

## v0.1.0 — 2026-06-05

First stable release. `@they-juanreina/compost-cli` + three scoped workspace
packages (`compost-provenance`, `compost-retrieval`, `compost-evals`) published
to npm; Cowork-distributed Claude Code plugin published from this repo.

Promoted from `v0.1.0-rc.2` after a successful real-corpus dogfood pass
([`scripts/dogfood-v0.1.0.sh`](scripts/dogfood-v0.1.0.sh)) — 17/17 functional
checks green on a 28-min meeting recording: install + version, multi-seed
status/saturate parity, the full v0.1.1 hardening loop (atomic create + AI
fail-fast, human-id endorse, endorse idempotency, tag filler/timestamp filter,
canonical-session resolver), native ASR (Parakeet on Metal) + diarization
(pyannote on MPS), and the missing-Ollama-model actionable error. The
small dogfood-script tunings (skip-audio handling for #191, widened #178
threshold for legitimate meeting recordings) ride with this release.

### Headlines

- **Native Apple-Silicon transcription** (Parakeet-TDT 0.6B v3 via `parakeet-mlx`
  + pyannote on Metal/MPS). ~16× realtime on an M1 Max vs ~0.8× in the Docker
  CPU fallback. (#176, #182, #183)
- **Three-actor provenance** (researcher / agent / AI-draft) with full
  `compost blame` lineage. AI-authored artifacts surface as `[draft]` until
  `compost endorse` promotes them.
- **Hybrid retrieval** — BM25 + LanceDB dense, wired into search and chat. (#151)
- **Claude Code plugin** with read + write MCP tools, the `compost-setup` doctor
  skill, and a `/compost-welcome` walkthrough. (#154, #155, #156)
- **Local-first by default** — `compost chat` routes to a local model
  (Ollama-backed) and no cloud key is required for the core loop. (#160)

### Hardening landed in v0.1.1 milestone (18 issues)

- Atomic create + AI-author fail-fast (no orphaned markdown on event-validation
  failure; `--ai` requires `actor-id`, `model`, and a 64-hex `prompt-hash`). (#165)
- `endorse` / `blame` accept the human id `create` prints (`C-slug`, `H-NNN`,
  `T-slug`) in addition to SHA prefixes and `latest:` refs. (#168)
- `endorse` is idempotent per `(artifact, researcher)` — re-running returns
  `status: "already_endorsed"`. (#169)
- `saturate` and `tag` share a canonical-session resolver with `status` — no
  more counting `Attachments/`, `Transcripts/`, … as sessions. (#166, #171)
- `tag` filters conversational filler and timestamp noise. (#171)
- `compost watch --once` reports failed jobs as `status: "completed_with_failures"`
  with exit 1. (#164)
- `compost setup --provision-native` provisions the native transcription venv
  in one step. (#183)
- Ollama 404 model-not-found surfaces as an actionable `CompostError`
  naming the exact `ollama pull X`. (#191)
- WhisperX honors `--language` on the per-call transcribe; native Parakeet
  path never records `language: "und"`. (#180, #190)
- Diarization over-segmentation collapse + `S?` orphan rescue — a clean
  2-party interview yields 2 speakers; meeting recordings keep their real
  participants. (#178)
- Stubbed commands (`query`, `synthesize`, `serve`) honestly flagged
  `[not implemented yet · #NN]` in `--help`; `--seed` in their contract. (#161, #167)
- Plus six more — see [milestone v0.1.1](https://github.com/they-juanreina/compost/milestone/6).

### Not in v0.1.0 (deferred)

Eight researcher-quality items live in
[milestone v0.1.2](https://github.com/they-juanreina/compost/milestone/7):
speaker labeling (#177), MMR / dedup in retrieval (#170), human-readable CLI
output (#173), `.txt` transcript importer (#172), `validate transcript.json`
subcommand (#174), `doctor` ↔ pulled Ollama model reconcile (#175), native
legacy-ingest (#184), CI ASR smoke (#185).

### Known limitations

- **The global npm install does not include the transcriber Python source.**
  `compost transcribe` (native runtime) needs both a venv (provisioned by
  `compost setup --provision-native`, lives at `~/.compost/transcriber-venv`)
  **and** the `transcriber/` package directory. For globally-installed
  cli, set `COMPOST_TRANSCRIBER_DIR=/path/to/compost/transcriber` (e.g. a
  repo clone). The Docker fallback works without the env var. Bundling the
  source into the global install is tracked for a future release.
- The 5%-share **diarization merge threshold** (#178) and the **EN/ES language
  heuristic** for the Parakeet path (#190) are deliberately conservative
  defaults. Corner cases (a legitimate 30-second third-speaker interjection,
  a corpus heavy on a third language) may need tuning. Both are pure helpers.
- `compost query` and `compost synthesize` are still stubs (tracked as #51 and
  #59). They show `[not implemented yet · #NN]` in `--help`.
- npm: `@they-juanreina/compost-cli` is scoped under the maintainer's npm
  handle. CLI binary is `compost`. `@they-juanreina/compost-{provenance,
  retrieval,evals}` are workspace packages cli depends on — not consumed
  directly.

### Agent-version vs release-version

The inline `AGENT_VERSION = '0.1.0'` constants in `cli/src/loops/*` and
`cli/src/lib/{tagcode,ingest}.ts` are agent-behavior semver, **not** release
version — stamped into `actor_id` on `actor_type=agent` events. They evolve
independently per agent. `PLUGIN_VERSION` in `plugin/mcp/tools.ts` **does**
track the release tag.

## v0.1.0-rc.2 — release candidate (promoted to v0.1.0)

Fixed rc.1's broken npm publish — `@they-juanreina/compost-cli` was published
with unresolvable `workspace:*` dependencies (`compost-provenance`,
`compost-retrieval`, `compost-evals` weren't on the registry), so
`npm i -g @they-juanreina/compost-cli@0.1.0-rc.1` 404'd on the workspace
deps. rc.1 was the validation we wanted before promoting to v0.1.0 — caught
exactly this.

- The three workspace packages renamed to `@they-juanreina/compost-{provenance,retrieval,evals}`, unprivated, given `publishConfig: { access: public }`.
- `cli/package.json` dependencies + 17 TypeScript imports updated.
- `.github/workflows/release.yml` publishes the three workspace packages **before** `compost-cli` on every tag.
- `release.yml` auto-flags `v*-rc.N` / `v*-beta` tags as prereleases (#22).
- Plugin-help and dogfood-script copy updated to point at the scoped name.

rc.1 (the broken version) deprecated on npm with a pointer to rc.2.

## v0.1.0-rc.1 — release candidate (broken — see rc.2)

> **Do not use.** This rc shipped a `compost-cli` whose `workspace:*` deps
> (`compost-provenance`, `compost-retrieval`, `compost-evals`) weren't
> published. `npm i -g …` 404s on those deps. Fixed in rc.2.

First release candidate. Validates the publish path before promoting to v0.1.0.
Contents are the same as the planned v0.1.0; the rc cycle exists so the npm
package name, plugin manifest sync, and GitHub Release notes can be confirmed
end-to-end without committing to the final version number.

### Headlines

- **Native Apple-Silicon transcription** (Parakeet-TDT 0.6B v3 via `parakeet-mlx`
  + pyannote on Metal/MPS). ~16× realtime on an M1 Max vs ~0.8× in the Docker
  CPU fallback. (#176, #182, #183)
- **Three-actor provenance** (researcher / agent / AI-draft) with full
  `compost blame` lineage. AI-authored artifacts surface as `[draft]` until
  `compost endorse` promotes them.
- **Hybrid retrieval** — BM25 + LanceDB dense, wired into search and chat. (#151)
- **Claude Code plugin** with read + write MCP tools, the `compost-setup` doctor
  skill, and the `/compost-welcome` walkthrough. (#154, #155, #156)
- **Local-first by default** — `compost chat` routes to a local model
  (Ollama-backed) and no cloud key is required for the core loop. (#160)

### Hardening (real-corpus dogfood — milestone v0.1.1, 18 issues)

- Atomic create + AI-author fail-fast (no orphaned markdown on event-validation
  failure; `--ai` requires `actor-id`, `model`, and a 64-hex `prompt-hash`). (#165)
- `endorse` / `blame` accept the human id `create` prints (`C-slug`, `H-NNN`,
  `T-slug`) in addition to SHA prefixes and `latest:` refs. (#168)
- `endorse` is idempotent per `(artifact, researcher)` — re-running returns
  `status: "already_endorsed"` instead of writing a duplicate event. (#169)
- `saturate` and `tag` share a canonical-session resolver with `status` — no
  more counting `Attachments/`, `Transcripts/`, … as sessions. (#166, #171)
- `tag` filters conversational filler and timestamp noise; ~100-token stopword
  set + drop any candidate containing a digit. (#171)
- `compost watch --once` reports failed jobs as `status: "completed_with_failures"`
  with exit 1 (was silently `ok` / exit 0). (#164)
- `compost setup --provision-native` provisions the native transcription venv
  (parakeet-mlx + pyannote + silero) in one step. (#183)
- Ollama 404 model-not-found surfaces as an actionable
  `CompostError`: `Ollama model 'X' not found — run \`ollama pull X\``. (#191)
- WhisperX honors `--language` on the per-call transcribe (was only passed to
  `load_model`, so per-file auto-detect ran anyway). (#180)
- Native Parakeet path never records `language: "und"` — getattr-on-result →
  configured hint → tiny EN/ES text heuristic → `"en"` (multilingual EN-first
  model). (#190)
- Diarization over-segmentation collapse + `S?` orphan rescue — a clean
  2-party interview yields 2 speakers (was 5–6 with three 1–3% slivers); orphan
  utterances inherit the temporally-nearest turn's speaker with confidence 0.
  (#178)
- Stubbed commands (`query`, `synthesize`, `serve`) are honestly flagged
  `[not implemented yet · #NN]` in `--help`; `--seed` is in their contract from
  the moment they ship. (#161, #167)
- Plus seven more — see
  [the v0.1.1 milestone](https://github.com/they-juanreina/compost/milestone/6).

### Not in v0.1.0 (deferred to a later patch / minor)

The eight researcher-quality items in
[the v0.1.2 milestone](https://github.com/they-juanreina/compost/milestone/7):
speaker labeling (#177), MMR / dedup in retrieval (#170), human-readable CLI
output (#173), `.txt` transcript importer (#172), `validate transcript.json`
subcommand (#174), `doctor` ↔ pulled Ollama model reconcile (#175), native
legacy-ingest (#184), CI ASR smoke (#185).

### Known limitations

- The 5%-share **diarization merge threshold** (#178) and the **EN/ES language
  heuristic** for the Parakeet path (#190) are deliberately conservative
  defaults. They cover the cases the dogfood corpus exposed; corner cases
  (e.g. a legitimate 30-second third-speaker interjection, a corpus heavy on a
  third language) may need tuning. Both are pure helpers — easy to revisit.
- `compost query` and `compost synthesize` are still stubs (tracked as #51 and
  #59). They show `[not implemented yet · #NN]` in `--help`; calling them
  errors with `status: "not_implemented"`.
- The `cli/` package publishes as `@they-juanreina/compost-cli` (scoped under
  the maintainer's npm handle). The CLI binary is `compost`.

### Agent-version vs release-version

The inline `AGENT_VERSION = '0.1.0'` constants in
`cli/src/loops/*` and `cli/src/lib/{tagcode,ingest}.ts` are agent-behavior
semver, **not** release version — they're stamped into `actor_id` on
`actor_type=agent` events. They evolve independently when an agent's behavior
changes, regardless of release tag. The `PLUGIN_VERSION` in `plugin/mcp/tools.ts`
**does** track the release tag (it's the same thing).
