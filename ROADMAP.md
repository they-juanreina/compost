# compost — Roadmap

This document is the design + milestone breakdown for compost. Issues link back to the relevant section. Decisions still open are tracked as `kind:decision` issues — see [the decisions queue](https://github.com/they-juanreina/compost/issues?q=label%3Akind%3Adecision).

## Why compost exists

Qualitative research today produces a lot of raw material that never gets fully used. Sessions land as `.docx` or `.csv` files that strip silences, paralinguistic cues, and any visual signal. Most sessions never get reviewed by a human, and most "research initiatives" never get consumed by anyone downstream. The system demands trust without earning it.

**compost** is a local-first, AI-first, open-source research analysis harness that ingests recordings *and* legacy research artifacts (PDF/PPTX/DOCX/CSV), produces *descriptive* transcripts (rich audio cues, semantically typed silences, prosody hints, a human-editable annotation field) paired with **screenshots captured at salient moments** for visual evidence, records every change with git-style three-actor provenance, lets researchers (and agents) highlight + code + theme across sessions, and runs autonomous loops so the corpus is continuously digested and queryable via grounded RAG — never wasted. Filesystem-canonical, agent-callable, human-usable. Works inside Claude Code and Cowork as a plugin; works from any other coding agent as a Bash-callable CLI.

## Positioning

- **Different from [anarlog](https://github.com/fastrepl/anarlog)** (personal meeting notetaker, Rust + Tauri, MIT): compost optimizes for *the corpus*, not the call. Borrows anarlog's architectural taste — on-device transcription, provider-agnostic LLM, markdown-as-truth, `AGENTS.md` prompt journal — but inverts the use case from "one meeting" to "twenty interviews that need to become a Thematic Map."
- **Uses and supersedes [research-os](https://github.com/they-juanreina/research-os)**: research-os skills become tools compost invokes through subagent calls. Several skills are refactored to be embedding-aware. Skills remain portable; the harness is the thing that disappears if you ever want to call them barehanded.
- **Different from Dovetail**: adopts the Dovetail data model (session > highlight > code > theme) but inverts the business model (local-first, agent-driven, MIT) and adds the autonomous-loop + retrieval + provenance layers no SaaS competitor ships.

## Storage layout

`Seeds/<name>/` is the top-level project metaphor. No numbered phase folders. Intent-named siblings + a hidden `.compost/` state directory.

```
Seeds/<name>/
  seed.md                # the question, status, owners
  plan/                  # research plan, discussion guides
  sessions/
    _inbox/              # drop recordings + legacy assets; watcher picks up
    S023/
      source.{mp3|mp4}
      transcript.json    # rich schema (§ Rich transcript)
      transcript.md      # human-readable mirror with cues inlined
      notes.md
  glossary/glossary.md
  highlights/            # one .md per highlight; frontmatter has utterance ref + provenance
  codebook/codebook.md
  synthesis/             # themes, journey maps, saturation pulses, reports
  exports/               # csv, pdf, pptx, ELAN .eaf
  legacy/                # ingested PDFs/DOCX/PPTX/CSV, normalized
  .compost/
    state.sqlite         # cache, indexes, job queues
    events.sqlite        # append-only provenance log (§ Provenance)
    vectors.lancedb/     # LanceDB embeddings index (§ Retrieval)
    evals.sqlite         # eval verdicts (§ Evals)
    AGENTS.md            # versioned prompt journal
    config.toml          # LLM providers, thresholds, feature flags
    work/<run_id>/       # scoped working dirs for subagent skill invocations
```

Filesystem (markdown + JSON) is canonical. `.compost/` holds derived/audit state, rebuildable with `compost reindex`. `compost migrate` renames legacy `01_*/02_*/03_*/04_*` seeds in place.

## Rich transcript JSON schema

Top-level: `schema_version, session_id, source, language, duration_ms, modality, speakers[], utterances[], silences[], cues[], frames[], glossary_refs[], provenance{}`.

- **Utterances** carry text + word timings + optional `prosody` hints + an **annotation** field (free-text, human-editable, AI-suggestible).
- **Silences** > 1500 ms are first-class with semantic typing (`after_question`, `mid_utterance`, `thinking`, `interruption`).
- **Cues** are audio-only in compost (laughter, sigh, cough, throat-clear, unintelligible, code-switching, overlap, interruption). No pose/gesture classification — that proved brittle and was dropped during design.
- **Frames** are screenshots captured at salient moments: every silence > 2s, every audio cue, every shot-change (frame-diff threshold), every highlight creation, and on demand. Each frame has a `trigger` reason, a path on disk, an optional AI `annotation`, and a `linked_utterance_id`.

```json
{
  "schema_version": "1.0",
  "session_id": "S023",
  "source": "sessions/S023/source.mp4",
  "language": "es-CO",
  "duration_ms": 3187420,
  "modality": ["audio","video"],
  "speakers": [
    {"id":"S1","name":"Juan","type":"moderator"},
    {"id":"S2","name":"P07","type":"participant"}
  ],
  "utterances": [
    {
      "id":"U-0001","speaker_id":"S2","turn":4,
      "start_ms":12480,"end_ms":18230,
      "text":"Cuando entra una alerta, yo... no sé si confiar.",
      "words":[
        {"w":"Cuando","s":12480,"e":12790,"conf":0.98},
        {"w":"entra","s":12790,"e":13020,"conf":0.97}
      ],
      "prosody":{"volume":"low","pace":"slow","hesitations":2},
      "annotation":"Voice trails off on 'confiar'; the silence that follows is the real answer.",
      "glossary_refs":[{"term_id":"T-alerta","span":[18,24]}]
    }
  ],
  "silences":[{"id":"SIL-014","start_ms":18230,"end_ms":21940,"duration_ms":3710,"context":"after_question"}],
  "cues":[
    {"id":"CUE-007","kind":"laughter","start_ms":42100,"end_ms":43500,"source":"audio","speaker_id":"S2","confidence":0.91}
  ],
  "frames":[
    {
      "id":"FR-001","at_ms":18800,"path":"sessions/S023/frames/000018800.jpg",
      "trigger":"silence_after_question","linked_utterance_id":"U-0001",
      "annotation":"P07 looks down and to the left, no movement for ~3s."
    }
  ],
  "provenance":{
    "transcriber":"compost-transcriber@0.3.1",
    "asr_model":"whisper-large-v3-event-tags",
    "diarizer":"pyannote-audio@3.3",
    "audio_cues":"silero-vad@5.0 + whisper-events",
    "frame_capture":"ffmpeg + shot-change@0.1",
    "frame_annotation":"moondream2@2026-04 (optional)"
  }
}
```

Frame `annotation` is optional and produced by a vision-capable model — Claude with vision when configured, Moondream2 local otherwise. Annotation events go through the standard three-actor provenance lifecycle: AI-authored, surfaced as `[draft]` until a researcher endorses or edits.

The full cue taxonomy is versioned in `schema/cues.taxonomy.json`. The frame trigger taxonomy lives in `schema/frames.taxonomy.json`.

## Data model

```
Project (1) ──< Seed (n)
Seed   (1) ──< Session, Glossary, Codebook, Theme, Insight, EventLog
Session(1) ──< RichTranscript (1) ──< Utterance (n)
Utterance(1) ──< Silence/Cue (n), Highlight (n)
Highlight(1) ──< Comment (n), Code (n via join)
Code (m) ──< (n) Theme
Glossary(1) ──< Term (n)             # span anchors back to Utterances
Insight(1)   ── derived from Theme + Highlight evidence

# Cross-cutting
Event   ──> any artifact (highlight, code, theme, term, suggestion)
Embedding ──> Utterance, Highlight, Code, Theme, Term, LegacyChunk
Eval    ──> any AI-authored event
```

Every artifact is **content-addressable** by SHA256 of its initial state and **versioned via the event log**.

## Provenance & the three-actor model

Every change to every artifact is an event in `.compost/events.sqlite`. Append-only. Three actor classes:

- **Researcher** — human, accountable, has an email/handle.
- **Agent** — deterministic-ish software actor (the cross-session-similarity scanner, a Claude Code slash command, a skill invocation), identified by `name + semver + prompt_hash`.
- **AI-suggestion** — raw LLM output, untrusted by default (`human_approved=false` until endorsed).

Schema:

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,        -- ULID
  ts            TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,           -- highlight|code|theme|term|insight|...
  artifact_id   TEXT NOT NULL,           -- SHA256 of initial state
  action        TEXT NOT NULL,           -- create|update|endorse|reject|link|unlink
  actor_type    TEXT NOT NULL,           -- researcher|agent|ai
  actor_id      TEXT NOT NULL,
  agent_name    TEXT,
  agent_version TEXT,
  prompt_hash   TEXT,                    -- sha256(prompt + model + temp + ctx_window)
  model         TEXT,
  payload       JSON NOT NULL,
  parent_event  TEXT REFERENCES events(id),
  batch_id      TEXT                     -- groups events from one loop run
);

CREATE TABLE snapshots (
  artifact_kind TEXT,
  artifact_id   TEXT,
  current_state JSON,
  version       INTEGER,
  last_event    TEXT REFERENCES events(id),
  PRIMARY KEY (artifact_kind, artifact_id)
);
```

Why this over Git: Git inside `.compost/` adds filesystem overhead and a branching mental model researchers don't want. Why over CRDT (Automerge/Yjs): CRDTs solve real-time multi-writer collaboration — compost is solo-first; an append-only log is simpler to audit.

**Lifecycle for AI suggestions**:

```
create (actor=ai, human_approved=false)
   └── endorse  (actor=researcher) → snapshot.author becomes hybrid, ai_assisted=true
   └── reject   (actor=researcher) → artifact archived, not deleted
   └── update   (actor=researcher) → researcher edits the AI draft; new event with parent
```

**UI patterns** (web): badges on every highlight and code — `[AI] [draft]`, `[agent: similarity-scanner@0.2.1]`, `[researcher: juan@] [endorsed]`. Click → lineage chain modal. Exports clearly mark un-endorsed AI content until promoted.

`compost blame <artifact_id>` prints the lineage chain in the CLI for agents to inspect.

### Reproducible provenance + agreement

The event log is also a reproducibility and trust-measurement layer (see [docs/provenance-deepening-design.md](docs/provenance-deepening-design.md)):

- **Captured inputs.** Migration `0003` adds an `ai_inputs` table; `events.input_id` content-addresses the reconstructable generation bundle (model, params, system prompt, prompt, context). `prompt_hash` remains as an integrity digest, but the bundle is now replayable — captured automatically for internal/agent calls and best-effort for host creates (`--inputs-file`). Prospective only (pre-migration events carry `input_id = NULL`).
- **`compost rerun <ref>`** — verify the inputs are intact (default), or `--apply` to regenerate and diff under an optional model override. Deterministic agents reproduce exactly; LLM regeneration is deferred.
- **`compost recode` + `compost agreement`** — a researcher codes a sampled highlight set *blind* (independently of the machine), then agreement reports Cohen's κ + Krippendorff's α over the doubly-coded set. This operationalizes the "conditional trust" the endorsement gate exists to manage; `recode` is deliberately human-only.
- **`compost export --format prov`** — W3C PROV-O (JSON-LD) export of the event log, so the three-actor provenance is externally verifiable and citable.

## Transcription — Python WhisperX, not anarlog reuse

Anarlog is MIT-licensed, so reuse is legally clean. But anarlog's pipeline:

- Captures audio → denoises (optional) → segments speech (pyannote ONNX local) → transcribes via Whisper-cpp or OpenAI → diarizes via pyannote → stores markdown.
- **Does not detect silences, laughter, sighs, or any paralinguistic cue.** That entire enrichment layer would need to be added.
- Is tightly coupled to Tauri's IPC and a desktop app model.

**Decision: build the transcriber in Python (FastAPI) inside OrbStack.** WhisperX bundles VAD + transcription + word-aligned diarization atomically; PyTorch on M1 MPS is solid; adding HuggingFace classifiers for laughter/sighs (Calm-Whisper / Whisper-AT event tags) is trivial in Python. The CLI stays Node-only with Python isolated in a container.

We will read three anarlog files for inspiration when laying out the FastAPI server: `crates/openai-transcription/src/realtime.rs` (transcript event schema), `crates/local-stt-server/src/lib.rs` (server shape), `crates/pyannote-cloud/src/lib.rs` (cloud-diarization fallback contract). Patterns, not code.

## Descriptive transcription + screenshot capture

Two complementary layers, no pose/gesture classification. Goal: rich evidence the researcher (or a vision-LLM) can interpret in context, not brittle ML predictions.

### A. Descriptive audio transcription (M1, on-device, open source)

- **Silero VAD** → silence segments with millisecond boundaries.
- **Whisper-large-v3** with event-tag tokens → `[laughter]`, `[sigh]`, `[cough]`, `[clear_throat]`, `[unintelligible]`, code-switching markers. Reduces hallucinations on non-speech by >80%.
- **pyannote-audio** → speaker diarization, overlap detection, interruptions.
- **Silence typer** → small heuristic post-processor that types silences by surrounding utterance context (`after_question`, `mid_utterance`, `thinking`, `interruption`). Versioned rules; researcher can override.
- **Prosody hints** per utterance — derived deterministically from word confidence, pyannote VAD energy, and speech rate: `{volume: low|normal|high, pace: slow|normal|fast, hesitations: count}`.
- **`annotation` field** per utterance and per cue and per silence — free-text, human-editable, AI-suggestible.

### B. Screenshot capture (M1 + M2)

`ffmpeg` extracts frames from the video stream at salient moments. **No pose/gesture detection. No classification.** Frames are evidence.

Triggers (configurable, ordered by default priority):

- **Silence > 2s** — pauses often correlate with body language.
- **Audio cue** — every `[laughter]`, `[sigh]`, `[cough]`.
- **Shot change** — perceptual-hash distance threshold.
- **Highlight creation** — contemporaneous frame auto-linked.
- **Manual snap** — `compost snap S023 --at 12:34` or one-click in the player.
- **Sampling fallback** — 1 frame every 60s if none of the above fire.

Stored at `sessions/<sid>/frames/<padded_ms>.jpg` (640×360). Indexed in `transcript.json` under `frames[]` and in `.compost/state.sqlite` for fast UI scrubbing.

### C. Frame annotation by a vision-capable LLM (M2, optional)

Per-frame one-sentence description, produced asynchronously:

- **Claude with vision** when `providers.anthropic` is configured.
- **Moondream2 local** for fully offline.
- **Off** by default; researcher can right-click any frame to run a single-frame annotation on demand.

The LLM is given the frame + the linked utterance text: *"In one sentence, describe what's visible that a researcher reviewing this interview might find notable. If nothing notable, return null."* Output is stored as an AI-authored event on the frame; surfaces as `[draft]` until endorsed.

### Compute budget on M1 Max 32GB

- Audio descriptive pipeline ≈ 0.3× real time. 60-min session transcribes in ~20 min.
- Frame extraction ≈ 0.05× real time. ~150–300 frames per 60-min session at default density.
- Optional Moondream2 annotation ≈ 2–3 s/frame. ~10 min added per 200 frames. Off by default.

## Retrieval — chat with the seed, grounded with citations

Replaces fan-out for single-seed queries. Keeps fan-out for cross-seed comparison.

- **Vector store**: LanceDB embedded in `.compost/vectors.lancedb/`. Disk-based IVF-PQ scales beyond RAM. M1-native. MIT-friendly. No server.
- **Embedding model**: BGE-M3 (Q4_K_M quantized) via Ollama. Multilingual (es-CO + en). 8192-token window.
- **Chunking**: utterance + 2-neighbor window primary; per-highlight bonus chunks; per-Term glossary chunks; per-page chunks for legacy PDFs. Metadata: `{seed, session, speaker_id, start_ms, end_ms, highlight_ids[], code_ids[], actor_type}`.
- **Hybrid retrieval**: BM25 + dense (BGE-M3) merged via Reciprocal Rank Fusion → top 50 → re-rank with bge-reranker-v2-m3 → top 5. Metadata filters at retrieval time.
- **Citation enforcement**: Anthropic Citations API native; deterministic validator for other providers (every claim must include `{quote, utterance_id, session_id, confidence}`; mismatch → reject).
- **Answers are content-addressable Insights** with provenance pointing at every cited utterance + model + prompt_hash. Insight's `author` is `ai-suggestion` until endorsed.

**Fan-out is retained for comparative cross-seed questions** ("how did seed X vs. seed Y frame trust?"). Compost detects multi-seed queries syntactically; each per-seed agent does RAG over *its* seed instead of cold-reading. Fan-out over RAG.

## Hallucination prevention

Five-layer defense:

1. **Retrieval-first** — no claim without a retrieved chunk; below the floor → "insufficient evidence" + seed-brief candidate.
2. **Citation enforcement** — Anthropic Citations API native; validator fallback.
3. **Schema-bound outputs** — every AI surface emitted through a JSON Schema with required `evidence: [{utterance_id, quote}]`.
4. **Verifier subagents** — for high-stakes artifacts, a second agent grades whether each claim's evidence supports it; below threshold → stays un-endorsed with verdict attached.
5. **Provenance gates** — nothing AI-authored is promoted into exports unless `human_approved=true` OR eval verdict above the export bar. Exports clearly distinguish endorsed vs. un-endorsed.

The web UI surfaces all five visibly.

## Batch ingest of legacy assets

`compost ingest` is the single entry point for:

- **Audio/video** → transcriber pipeline.
- **PDF** → pdfminer.six + pdfplumber; one `Utterance`-equivalent per paragraph; OCR via Tesseract for scanned PDFs.
- **DOCX** → python-docx; one Utterance per paragraph; headings preserved.
- **PPTX** → python-pptx; one Utterance per slide (notes + bullets concatenated); slide thumbnails extracted.
- **CSV** → column-mapped via `compost ingest --map text=Quote --map speaker=Participant`.
- **Notion / Linear / Markdown exports** → markdown ingestor with frontmatter passthrough.

All legacy assets land in `legacy/` and produce a normalized JSON sibling that the rest of compost treats like a transcript — embeddings, highlights, codes, themes all work the same way. `compost ingest <folder>` runs the whole flow as a resumable batch.

## The harness loops

Cooperative Node processes consuming job-queue tables in `.compost/state.sqlite`. Each can be paused, restarted, or run in isolation. None silently rewrite human-authored markdown — writes go to `suggestions.*` tables surfaced through the event log.

1. **ingest-watcher** — routes audio/video to transcriber, legacy assets to legacy-ingest.
2. **transcribe-worker** — emits transcript.json with descriptive audio layer. Yields when diarization confidence < threshold.
3. **frame-capture worker** — extracts frames at trigger events.
4. **frame-annotation worker** (optional, M2) — runs Claude-with-vision or Moondream2 to produce one-sentence descriptions.
5. **legacy-ingest-worker** — PDF/DOCX/PPTX/CSV normalization.
6. **embed-worker** — embeds every new artifact into LanceDB. Idempotent on SHA.
7. **glossary-grower** — proposes glossary additions on every new transcript / highlight.
8. **cross-session-similarity scanner** — runs over embeddings; suggests existing codes; drafts candidate codes for un-coded clusters.
9. **saturation-pulse** — invokes `saturation-analysis` skill on coded corpus.
10. **eval-grader** — runs verifier subagent over AI-authored events; writes verdicts to `.compost/evals.sqlite`.
11. **rag-rebuilder** — rebuilds LanceDB indexes when config changes.

## Skills relationship & refactoring

compost **uses** research-os skills as tools, doesn't replace them. The harness invokes them as subagent calls into `.compost/work/<run_id>/`. Three skills get refactored to be embedding-aware and eval-instrumented:

- **`querying-research-knowledge`** → RAG-first; fan-out path retained for explicit multi-seed comparisons. 5–10× cost drop on single-seed queries.
- **`thematic-coding`** → consumes embeddings to suggest code clusters; outputs structured codebook with per-code evidence anchors.
- **`saturation-analysis`** → reads from the embeddings index for novelty per session.

Refactored wrappers ship in `plugin/skills/`; originals remain at the research-os layer untouched.

## Evals

Three eval surfaces, all in `.compost/evals.sqlite`:

1. **Skill evals** — golden-set examples per skill (5–20 fixtures per skill). `compost evals run --skill thematic-coding` regenerates outputs, scores them on coverage, faithfulness, schema conformance. CI-friendly.
2. **AI-suggestion evals (live, per event)** — eval-grader loop. LLM-as-judge with fixed versioned rubric → `{verdict, score, explanation}` per suggestion.
3. **End-to-end harness evals** — "complete seed" fixtures (input recordings + expected synthesis artifacts). `compost evals harness` diffs against expected; gates major releases.

Eval results are first-class in the UI — every AI artifact shows its eval score. No external eval SaaS by default; optional self-hosted Langfuse via `config.toml`.

## Learning mechanisms

- **Project glossary that grows** — every tagged term and recurring noun phrase becomes an AI-suggested Term; on endorsement, injected into every subsequent LLM call in this seed.
- **Codebook reuse across seeds** — codes/themes scoped per-Seed by default, addressable from siblings. Stable codebooks emerge.
- **Prompt journal (`.compost/AGENTS.md`)** — anarlog-style. User-editable, versioned with the seed, diffable.
- **Eval feedback loop** — researcher rejections become labeled negative examples; after N rejections of the same shape, the rejection set is appended to the skill's eval golden-set automatically.

## Tech stack

- **CLI** — TypeScript / Node. Same ecosystem as Claude Code; first-class MCP SDK.
- **Transcription worker** — Python (FastAPI) wrapping WhisperX + pyannote + Silero VAD + Whisper-event-tags + silence typer + prosody extractor. OrbStack container via `compose.yaml`.
- **Frame worker** — Python (same container), ffmpeg for extraction + perceptual-hash shot-change detector. Optional Moondream2 lazy-loaded.
- **Legacy-ingest worker** — Python (same container). pdfminer.six, pdfplumber, python-docx, python-pptx, tesseract.
- **Web UI** — Next.js (App Router, shadcn). `better-sqlite3` for reads; mutations dispatch the CLI engine.
- **Storage** — `.compost/state.sqlite` (cache + job queues), `.compost/events.sqlite` (provenance), `.compost/vectors.lancedb/` (embeddings), `.compost/evals.sqlite` (verdicts). Markdown/JSON on disk is canonical.
- **LLM** — provider-agnostic adapter. Default: Ollama. Supports LM Studio, Anthropic, OpenAI, Azure, Bedrock.

## LLM provider switching — Ollama and LM Studio side-by-side

Providers configured per-seed in `.compost/config.toml`, with per-task routing:

```toml
[providers.ollama]
base_url = "http://localhost:11434"

[providers.lmstudio]
base_url = "http://localhost:1234/v1"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[defaults]
embeddings   = "ollama:bge-m3"
quick_chat   = "ollama:llama3.1:8b"
synthesis    = "anthropic:claude-opus-4-7"
verification = "lmstudio:qwen3-72b-instruct"
```

Tasks (quick_chat, synthesis, verification, embeddings, code-suggest, theme-draft, …) map to provider+model independently. A single compost run can embed via Ollama, draft a theme with Anthropic, and verify with a heavy local LM Studio model — concurrently.

## Interfaces — CLI + local Next.js web

- **CLI (`compost ...`)** — Node/TypeScript. Subcommands: `init`, `ingest`, `transcribe`, `watch`, `tag`, `code`, `synthesize`, `query`, `chat`, `status`, `blame`, `export`, `serve`, `migrate`, `reindex`, `models doctor`, `evals run`, `evals harness`, `config get|set`. JSON output by default (`--json`); TTY-pretty with `--human`.
- **Local web UI (`compost serve`)** — Next.js App Router on `localhost:7860`. Synchronized transcript/video player with cue overlay + frame strip, drag-to-highlight, color-coded code palette, theme boards, provenance badges + lineage modals, chat-with-seed panel with citations, eval scores on AI artifacts, side-by-side cross-session comparison, glossary inline suggestions.

Tauri-wrap into a desktop bundle later; not v1.

## Agent integration

- **Universal**: any agent can call `compost` via Bash.
- **Claude Code plugin (`compost.plugin`)**: bundles slash commands (`/compost-ingest`, `/compost-status`, `/compost-tag`, `/compost-chat`), wrapped skills, and an MCP server exposing operations as typed tools.
- **Cowork packaging** (M3): same plugin published to the Cowork registry.

## MVP / phasing

- **M1 — Compost core (4–6 weeks)**: `compost init|ingest|transcribe|snap|watch|status|blame|export|migrate|reindex|config`. Rich transcript schema with audio cues, semantically typed silences, prosody hints, speaker diarization, screenshot capture. Provenance event log + three-actor model. Legacy ingest for PDF/DOCX/PPTX/CSV. LanceDB index built but not yet queried. Ollama default with LM Studio side-by-side. Bash-callable from Claude Code. *Ships when (a) `_inbox/session.mp4` → `transcript.json` with audio cues + frames lands autonomously, (b) `compost blame` shows the lineage of any artifact, (c) a folder of mixed legacy PDFs + .mp3 + .mp4 batch-ingests successfully.*
- **M2 — Annotation + retrieval (4–6 weeks)**: highlights (including frame-anchored), comments, codes, glossary, codebook UI. Cross-session-similarity scanner over LanceDB. RAG-grounded `compost chat` with citations + schema-bound JSON. Optional frame annotation via Claude-with-vision or Moondream2 local. Next.js web UI with provenance badges, lineage modals, transcript/video player with frame strip + timeline cue markers. MCP server + slash commands for Claude Code. Glossary-grower loop. Eval-grader loop. Refactored `querying-research-knowledge` and `thematic-coding` skills. *Ships when a researcher runs a 12-session project end-to-end with grounded chat, frame-anchored highlights, and per-artifact provenance, never opening a spreadsheet.*
- **M3 — Synthesis + Cowork (6–8 weeks)**: autonomous theme suggestion via refactored `thematic-coding`, journey-map drafting, saturation-pulse, prompt-journal UI. Cowork plugin packaging. ELAN `.eaf` export. PDF report + PPTX exports. End-to-end harness evals. Frame-annotation tightening. *Ships when a seed produces a stakeholder-ready, citation-grounded report on its own, with provenance visible.*

## Verification

- **End-to-end M1 smoke test**: drop a 30-min mp4 in `Seeds/Test/sessions/_inbox/`. Run `compost watch`. Within ~10 min on M1 Max 32GB, `transcript.json` lands with utterances, typed silences, audio cues, and frames. `transcript.md` mirrors it.
- **Provenance test**: create a highlight; `compost blame` shows actor=researcher. Endorse an AI-suggested code; blame shows the chained AI + endorsement events.
- **Legacy batch test**: a folder of mixed PDFs/PPTX/DOCX/CSV/mp3/mp4 processes; `compost status --json` shows kind-grouped counts.
- **Schema validation**: `compost validate transcript ...` passes; cues and frames validate against their taxonomies.
- **RAG citation test (M2)**: `compost chat` returns answers with utterance_id citations; validator rejects citations not in retrieval set.
- **Hallucination smoke test (M2)**: unanswerable query returns "insufficient evidence" + seed-brief candidate, not a fabricated answer.
- **Multi-provider test**: embeddings via Ollama, synthesis via Anthropic, verification via LM Studio — all in one run.
- **Offline test**: with Ollama running and network disabled, full `init → ingest → chat` flow completes.
- **Frame capture test**: deliberate silences and a laugh trigger frame captures at the right ms; each points at an existing JPG.
- **Frame annotation test (M2)**: with Moondream2 configured, frames get annotations carrying `actor_type=ai`; endorsement changes the lineage chain.
- **Eval gate (M2)**: `compost evals run --skill thematic-coding` reports pass/fail and exits non-zero on failure.
- **Migration test**: `compost migrate --dry-run` on a legacy `01_*/02_*` seed previews the rename safely.
- **Web UI provenance**: every highlight shows actor badge; clicking opens a lineage modal.

## Open decisions

Tracked as [`kind:decision` issues](https://github.com/they-juanreina/compost/issues?q=label%3Akind%3Adecision):

- Frame annotation posture (M2): off vs Moondream2 default vs per-seed switch.
- Frame capture trigger density: `dense | balanced | sparse` profile vs config-only tuning.
- `annotation` field defaults: human-only vs AI-suggested-then-endorse.
- Eval tooling posture: local SQLite only vs optional self-hosted Langfuse.
- AI-suggestion visibility in exports: marked `[draft]` vs hidden until endorsed.
