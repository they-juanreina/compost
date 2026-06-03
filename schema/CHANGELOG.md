# Schema CHANGELOG

All notable changes to the JSON Schemas under `schema/`. Each schema is independently versioned; breaking changes bump the major.

## transcript.schema.json

### 1.0 — 2026-06-02 (initial)

The rich transcript contract. Top-level keys: `schema_version`, `session_id`, `source`, `language`, `duration_ms`, `modality`, `speakers`, `utterances`, `silences`, `cues`, `frames`, `glossary_refs`, `provenance`.

- `utterances[].annotation` is a free-text editorial layer. Per-event provenance (`researcher | agent | ai`) lives in `.compost/events.sqlite` — this field is the current-state snapshot only.
- `cues[].source` is fixed to `"audio"`. No pose/gesture cues by design.
- `frames[]` are screenshots indexed by trigger; see `frames.taxonomy.json`.
- `silences[].context` is one of `after_question | mid_utterance | thinking | interruption`.
- `prosody` hints are deterministic-derived (word confidence + VAD energy + speech rate), not ML predictions.

Example fixture: [`examples/S023.transcript.json`](examples/S023.transcript.json).

Validation:

```
compost validate transcript schema/examples/S023.transcript.json
```

(Sibling issue [#3] wires up the CLI subcommand.)
