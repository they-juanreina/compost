# schema

Versioned JSON Schemas — the load-bearing contracts every component depends on. Any change is a migration.

- `transcript.schema.json` — rich transcript v1.0 (utterances, silences, cues, frames, prosody, glossary refs, provenance).
- `cues.taxonomy.json` — audio cue catalog (laughter, sigh, cough, throat-clear, unintelligible, code-switching, overlap, interruption) with confidence floors per kind.
- `frames.taxonomy.json` — frame trigger catalog (silence_after_question, audio_cue, shot_change, highlight, manual, sampling).
- `events.schema.json` — append-only provenance event shape.

See [ROADMAP.md § Rich transcript JSON schema](../ROADMAP.md#rich-transcript-json-schema).
