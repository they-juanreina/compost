# Quickstart (5 minutes)

Get a feel for compost without recording anything — start from the bundled
sample seed, then point it at your own material.

## 1. Install

First check you have a Node package manager. Run:

```sh
node --version    # want v22 or newer
pnpm --version    # the install command below uses pnpm
```

If either prints `command not found`, you don't have Node yet — install it before
going further. On macOS the shortest path is [Homebrew](https://brew.sh):

```sh
# install Homebrew (skip if `brew --version` already works)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# install Node (bundles npm) and pnpm, then re-check
brew install node pnpm
node --version && pnpm --version
```

On Windows/Linux, install Node from [nodejs.org](https://nodejs.org) (or your
package manager), then `npm install -g pnpm`. With Node and pnpm on your `PATH`:

```sh
pnpm add -g @they-juanreina/compost-cli      # or: brew install they-juanreina/tap/compost
```

> Seeing `zsh: command not found: npm` (or `pnpm`)? That's this step: the package
> manager isn't installed yet, not a compost problem. Install Node as above and
> re-run.

## 2. Open the sample seed

```sh
compost init sample --from-sample
compost status --seed sample --human
```

You now have a fully-formed corpus: one transcribed session (with a typed
silence, a sigh cue, and a frame), two highlights, two codes, and one theme —
`control-earns-trust`.

## 3. Look around

```sh
# the rich transcript, human-readable
compost export Seeds/sample/sessions/S001/transcript.json --format md --human

# who created what (three-actor provenance)
compost blame latest:highlight=sample --seed sample --human

# ask the corpus a question — answers carry citations, or say "insufficient evidence"
compost chat "¿por qué desconfían de las alertas?" --seed sample --human
```

## 4. Start your own

```sh
compost init my-study
# drop recordings + legacy PDFs/DOCX/PPTX/CSV here:
open Seeds/my-study/sessions/_inbox

# run the loops (filesystem watcher → transcribe → frames → embed)
compost watch --seed my-study
```

On Apple Silicon, transcription runs **natively** (Metal, ~16× realtime) — see
[transcription.md](transcription.md) to provision the venv. The cross-platform
fallback is the Docker container:

```sh
docker compose -f transcriber/compose.yaml up --build   # one time (fallback)
curl http://localhost:7862/health
```

That's it. Everything is files on disk under `Seeds/`; `.compost/` holds
derived state you can rebuild with `compost reindex`.

See the [tutorials](tutorials/) for the full researcher and agent walkthroughs.
