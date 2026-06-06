# Changelog

## v0.1.0-rc.1 — release candidate

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
