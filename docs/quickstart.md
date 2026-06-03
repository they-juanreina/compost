# Quickstart (5 minutes)

Get a feel for compost without recording anything — start from the bundled
sample seed, then point it at your own material.

## 1. Install

```sh
pnpm add -g @they-juanreina/compost-cli      # or: brew install they-juanreina/tap/compost
```

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

The transcriber runs in OrbStack:

```sh
docker compose -f transcriber/compose.yaml up --build   # one time
curl http://localhost:7862/health
```

That's it. Everything is files on disk under `Seeds/`; `.compost/` holds
derived state you can rebuild with `compost reindex`.

See the [tutorials](tutorials/) for the full researcher and agent walkthroughs.
