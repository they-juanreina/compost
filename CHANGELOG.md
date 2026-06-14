# Changelog

## Unreleased

Opens the **analytic memos** milestone (#9): a first-class, provenance-bearing,
*codable* interpretive artifact — the analyst's dated, evolving record (Saldaña;
ADR 0004). Built on a recorded maintainer override (kill filter clears 1–3;
"validated need" is grounded-but-not-demonstrated against the single-study
dogfood — see [`docs/design-analytic-memos.md`](docs/design-analytic-memos.md)).
The web surface is deliberately deferred (CLAUDE.md live tension).

### Added

- **`compost memo new|list|view|edit|cite`** — write and link analytic memos
  (`M-<slug>`, `synthesis/memos/`). A memo carries a `type` (constrained set:
  code | category | theme | reflexive | method | theory | freeform) and a
  heterogeneous **anchor** set pointing at highlights, codes, categories, themes,
  codebooks, or other memos (metamemos); zero anchors = a project-level reflexive
  memo. Researcher-authored memos are born endorsed; AI-drafted memos (`--ai`,
  and the `compost_create_memo` MCP tool) are born `[draft]` until a researcher
  `compost endorse`s them — the same three-actor gate as codes/themes. Editing
  emits an `update` event, so the append-only ledger carries the memo's evolution
  (Saldaña's "series of dated snapshots").
- **Memos are codable** — a theme may cite a memo in its evidence set
  (`--evidence memo:M-x`). A memo cited as evidence is frame-neutral and
  **excluded from saturation / κ** (a memo is not a participant utterance), so it
  never inflates coverage.
- **`compost_create_memo` + `compost_list_memos`** MCP tools, and the
  **`/analytic-memos`** skill (drafts grounded memos behind the endorse gate).
- `compost status` now counts memos; PROV-O export and `reindex` cover the memo
  kind. Memos are intentionally kept out of `search`/grounded-chat retrieval
  (interpretation, not corpus).

## v0.2.1 — 2026-06-13

Completes the **codebook & category data model** milestone: the two codebook
verbs gated behind a validated need (#269) now ship, built on the qualified
code-id foundation from v0.2.0.

### Added

- **`compost codebook duplicate <source> <new-name>`** — copy a codebook as a
  new, independent lens. Definitions + a `derived_from` lineage link travel;
  coded instances (evidence) do **not** — the copy enters un-grounded and earns
  its grounding by being coded against the local data (framework / deductive
  coding). `--from <seed>` reads the source from a sibling seed, reusing a
  validated frame across studies. Refuses an in_vivo source (participant-verbatim
  names can't be re-homed without their evidence). Researcher-authored, additive
  (rejects rather than overwrites). Exposed as `compost_codebook_duplicate`.
- **`compost codebook merge <from> <into>`** — fold one lens into another.
  Re-homes the source's codes (an `update`, not a copy — identity, evidence, and
  history preserved), then reject-archives the source (never deletes). Colliding
  names are kept distinct (`distrust` → `distrust-from-<frame>`), never silently
  fused; coverage math (`saturate` / `agreement`) sees the two as distinct until
  the researcher de-dups. Dry-run by default (`--apply` to write), with a
  dirty-tree guard. Refuses when a re-homing code is cited by a theme or category
  link — those carry cross-lens / one-frame invariants a structural fold must not
  silently re-decide. Exposed as `compost_codebook_merge`.

### Changed

- `fork` and `import` collapsed into `duplicate` (the source is a flag, not a
  separate verb); both CLI commands are removed. `import` is documented as the
  NVivo/ATLAS.ti term the cross-seed `--from` case maps to.

## v0.2.0 — 2026-06-12

The **codebook & category data model** milestone: codes now live inside declared
interpretive lenses (codebooks), group into second-cycle categories, and ground
themes through a heterogeneous evidence model. Two on-disk formats changed — both
back-compatible for existing seeds (see **Migration** below).

### Added

- **Codebooks — interpretive lenses codes belong to (ADR 0001).** `compost
  codebook new <name> --stance <inductive|deductive|in_vivo|framework>`, plus
  `list` and `migrate`. Every code carries a `codebook_id`; the implicit
  `CB-primary` frame needs no setup. `--codebook` scopes `agreement`, `recode`,
  and `saturate` so a deductive lens and an inductive lens are measured
  separately. Exposed through codebook MCP tools and the `/compost-codebook`
  slash command.
- **Category tier — second-cycle / pattern coding (ADR 0002).** A `Category`
  artifact groups codes within one frame via `link(code → category)` events
  carrying `is_primary` (the coverage-driving home; additional links are axial).
  `compost category` verbs; AI-proposed categories via code-centroid clustering.
- **Theme evidence model.** Themes rest on a heterogeneous
  `evidence[{kind: code | category, ref, codebook_id}]` set rather than a flat
  code list, so a theme can draw on first-cycle codes, second-cycle categories,
  or both. **Cross-lens themes** (`--cross-lens`, `codebook_id: null`) bridge two
  or more codebooks and must cite evidence from ≥2 frames.
- **Source/author attribution for sourced documents (#270).** A transcript-level
  `attribution { author, title, year, url, citation }` with a structured
  CSL-flavored `citation`, so a citation over a published interview / theory text
  names its author instead of a fabricated speaker. `author`/`year` are
  filterable in retrieval.
- **Qualified code ids (#269 foundation).** Codes are namespaced by frame —
  `C-<codebook>/<code>` on disk at `codebook/<codebook>/<code>.md` — so lenses
  can each hold a same-named code. `compost codebook migrate-ids` normalizes
  existing seeds (dry-run first).
- **`in_vivo` codebook stance enforcement (#268).** An in-vivo code's name must
  appear verbatim in one of its evidence highlights.
- **Codebook-filtered retrieval + chunk backfill (#275).** `compost reindex
  --vectors` (and the embed-worker pass) backfill `code_ids` / `codebook_ids`
  onto already-embedded chunks, and retrieval can filter by codebook or code.
- **Legacy-ingest cleanup (#271).** The PDF ingestor strips repeated running
  headers/footers and splits inline `Name:` turn labels into speaker-attributed
  utterances.

### Changed

- **BREAKING (theme payload): `codes[]` → `evidence[]`.** New themes write the
  evidence set; code-only themes also dual-write a legacy `codes[]` during the
  deprecation window. Existing `codes[]` themes are **lazy-mapped** on read, so
  no migration is required to keep reading them. `compost saturate` is rewired to
  resolve evidence (a `category` ref expands to its primary member codes).
- **BREAKING (code id form): bare `C-<slug>` → `C-<codebook>/<slug>`.** New codes
  are namespaced. A bare `C-<slug>` still resolves everywhere as a shorthand
  (unique-or-error across frames), so **existing seeds keep working unchanged**;
  run `compost codebook migrate-ids` to rewrite ids to the qualified form.

### Fixed

- Post-ingest highlights are embedded into the scanner's sidecars, so codes
  created after ingest become visible to `rescan` / `code` (#262).
- `compost saturate` emits an explicit `insufficient` signal on a single session
  (instead of a bare `pause`), and `export --format prov` writes a file to
  `exports/` rather than only returning JSON inline (#272, #273).

### Migration

Existing seeds need no action to keep working — both format changes are
back-compatible (theme `codes[]` lazy-maps; bare code ids resolve via a
shorthand shim). To adopt the new on-disk forms: run `compost codebook
migrate-ids` (dry-run first) to namespace code ids, then `compost reindex
--vectors` to refresh chunk metadata.

## v0.1.4 — 2026-06-11

### Added

- **Per-item setup maintenance: `compost setup item list | show | run`.** Once
  an install is set up, the gap-driven wizard could no longer act on a single
  prerequisite — there was no way to change, renew, or revoke a stored
  HuggingFace token. The new surface addresses one check by its stable id:
  `list` shows every check plus the lifecycle actions available on it, `show
  <id> [--validate]` re-probes one (and, with `--validate`, runs a live
  HuggingFace `whoami` check so a revoked/expired token reads as `live: fail`
  instead of surfacing as a confusing pyannote 403), and `run <id> <action>`
  performs one action — `renew` (store a new token, then validate), `forget`
  (remove compost's local copy; names the hf.co delete step it cannot do, and
  refuses to imply success for a shell-exported token), plus the generalized
  `model:<name> pull` and `secret-perms:<path> fix`. Mutating actions require a
  TTY or `--yes`. The read-only `compost setup --json` report is unchanged
  byte-for-byte. The TTY wizard gains a "maintain an item?" step once the
  install is healthy, and the `/compost-setup` skill wraps the same verbs.
- **`compost setup` reuses installed Ollama chat models instead of forcing a
  pull.** The local-chat step now lists chat models already in Ollama (embedding
  models like `bge-m3` filtered out) and lets you pick one with no download;
  pulling a default (`llama3.1:8b`) becomes just one more option, used when
  nothing suitable is installed.

### Fixed

- **`compost setup` no longer hangs on a slow HuggingFace.** The pyannote
  gated-license probe was a bare fetch with no timeout; it now time-boxes each
  request (5 s) and, on a timeout or when offline, reports "could not verify
  license" rather than mislabeling it "not accepted".
- **`compost backup` takes a consistent snapshot of the event ledger.** It now
  copies `events.sqlite` via SQLite `VACUUM INTO` instead of a raw file copy, so
  a backup taken while a worker is writing (or in WAL mode) can't capture a torn
  ledger — the one artifact this command exists to protect.

### Hardened

- **Session-id containment is asserted at every write/exec site.** `getSession`,
  `snap`, `transcribe`, and `import` now assert the resolved session path stays
  under `<seed>/sessions/` (belt-and-braces over the strict id regex), so a
  future loosening of that regex can't open a path traversal.
- **`compost setup item run` gates mutations on a real TTY, not `--human`.** A
  mutating action run non-interactively still requires `--yes`, and that gate can
  no longer be bypassed by forcing the `--human` output flag.
- Status glyphs (`✓ ✗ ⚠`) degrade to ASCII under a non-UTF-8 locale across the
  setup report, the wizard, and the secrets output.

### Internal

- Consolidated repeated idioms into shared helpers — `errMessage`,
  `statusGlyph`, `failedHealth`, `readStdin`, `fetchWithTimeout`,
  `isContainedUnder`, `eventsDbPath` / `openReadonlyEvents`, `runNativeCli`, and
  `seedNameOf` — and removed dead code. No user-facing behavior change.

## v0.1.3 — 2026-06-10

Onboarding becomes a guided path instead of a checklist (`compost setup` wizard,
auto-linked documents, dead-letter queue recovery — see
[docs/onboarding-journey.md](docs/onboarding-journey.md)), and provenance
deepens from an audit trail into a reproducibility + agreement layer
([docs/provenance-deepening-design.md](docs/provenance-deepening-design.md)).

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

- **A moved or renamed study folder keeps a working queue (#240).** Job rows
  and ingest events now store paths relative to the seed root (in-seed files
  only — `compost ingest` targets outside the seed stay absolute, and are now
  resolved against the cwd at enqueue time instead of stored verbatim).
  Workers resolve rows against the current seed location; legacy absolute
  rows from before this change are recovered by re-rooting their
  `sessions/…` tail under the seed.
- **`compost setup` warns when the install is outdated (#245).** A
  best-effort npm dist-tag probe (silently skipped offline) compares the
  running version to `latest`; the wizard offers the upgrade as its first
  step, and the provision-native locator error now names the usual cause —
  an install predating the bundled transcriber — with the upgrade command.
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
