# Troubleshooting

Run `compost setup` first — most problems below are one of its checks.

## `compost search` returns nothing / "No indexed sessions"

The seed has no `transcript.json` files yet, or they haven't been embedded.

- Confirm sessions exist: `compost status --seed <name>` (look at `sessions.transcribed`).
- Run the pipeline: `compost watch --once --seed <name>` (ingest → transcribe/normalize → embed).
- If audio is stuck `queued`, transcription hasn't run yet — see below.

## Embeddings fail / `compost watch` logs "embed failed"

Almost always Ollama. `compost setup` will show it.

- `ollama serve` (or open the app), then `ollama pull bge-m3`.
- Verify: `compost models doctor --seed <name>` shows the `embeddings` task `ok`.
- The supervisor logs embed failures and continues — ingest/transcribe still
  progress; only the index is behind until Ollama is back.

## `compost transcribe` is slow, 404s, or "transcriber service unreachable"

On **Apple Silicon**, use the native runtime (the default) — far faster than
Docker and no container needed. If it prints a "native not provisioned" note and
falls back to Docker, set up the native venv: see
[transcription.md](transcription.md) (or run `compost setup`).

The **Docker fallback** 404s when the container isn't up:

```sh
docker compose -f transcriber/compose.yaml up --build -d
curl http://localhost:7862/health    # expect {"status":"ok",...}
```

First build downloads multi-GB model weights; subsequent runs are cached.

## A session is stuck `queued` and `compost watch --once` does nothing

A failed job retries automatically, but only **3 times** — after that it parks
as permanently failed and the watcher skips it. `compost watch --once` exits
non-zero and names the count, and the seed's `warnings[]` in `compost status`
point here.

- Inspect: `compost jobs --seed <name>` (the `error` column says why it died —
  usually the transcriber service was down, see above).
- Fix the cause, then retry: `compost jobs requeue --seed <name>` followed by
  `compost watch --once --seed <name>`.
- `requeue` warns if a job's source file no longer exists on disk (e.g. the
  seed folder was moved or renamed by hand) — re-drop the file into
  `sessions/_inbox/` in that case.

## pyannote 403 / "license not accepted" even though the model page loads

The model *page* loading is not proof — the gated *file* is what's checked.

- Accept the license on **both** repos, logged into the HF account that owns
  your token: [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
  and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0).
- Confirm the token is the same account: a token from account A won't inherit
  account B's license acceptance.
- Re-check: `compost setup` fetches `…/resolve/main/config.yaml` and expects 200.

## The MCP tools error with `CLI_NOT_FOUND`

The plugin can't find the compost CLI (it doesn't bundle it).

- Make `compost` callable on PATH, **or**
- Set `COMPOST_CLI=/abs/path/to/compost/cli/dist/index.js`.
- See [install.md](install.md) step 2.

## `compost blame <ref>` says "Multiple seeds … Pass --seed"

You're in a workspace with more than one seed and used a bare SHA prefix.
Either pass `--seed <name>`, or use a `latest:<kind>=<seed>` ref which names the
seed itself (e.g. `compost blame latest:highlight=my-study`).

## `compost status` shows surprising session counts

After migrating a legacy `01_*/02_*` seed, non-canonical folders under
`sessions/` (e.g. `Notes/`, `Transcripts/`) are **not** counted as sessions —
they appear in the `warnings[]` array instead. A folder counts as a session
only if it's named `S<digits>`, has a `transcript.json`, or has a `source.<ext>`.

## `compost config set` stored the wrong type

`set` stores strings by default. For a non-string value, pass `--type`:

```sh
compost config set features.beta true --type=bool
compost config set limits.max_workers 4 --type=int
```

## Still stuck

`compost <command> --help` documents every flag. For bugs, the event log
(`compost blame`) and `compost setup --json` output are the most useful things
to include in a report.
