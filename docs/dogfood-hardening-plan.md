# v0.1 dogfood → hardening plan

Consolidated findings from running the **documented researcher-first flow end-to-end on a real research corpus** (text-transcript project + audio-recording project), on an Apple M1 Max. Everything below is tracked in milestone **v0.1.1 — hardening (real-corpus dogfood)** (issues #160–#180).

> Corpus details are de-identified. Working seeds live **outside this repo** (e.g. `~/compost-seeds/`); `Seeds/` stays gitignored.

---

## TL;DR

The **hard, novel core is sound** — provenance (create → endorse → blame), retrieval storage + hybrid search, migrate, export, and the **real WhisperX + pyannote audio pipeline** all work on real data. The gaps cluster in three places:

1. **The answer path** — `chat` needs a cloud key; `query`/`synthesize` are stubs (P0).
2. **Real-world ingest** — the Dockerized pipeline can't see seeds outside the repo, and **CPU-only transcription is too slow** for hour-long interviews (P0).
3. **Conversational-data quality** — chunk dedup, tag noise, anonymous speakers, over-diarization (P1/P2).

None of it is in the provenance/retrieval foundation — which is the encouraging part.

---

## What works (validated on real data)

- **migrate** → canonical structure + `.compost/`, preserves an existing `seed.md`.
- **Session → embed → LanceDB** → hybrid search. A real interview (519 utterances) embedded to ~1000 chunks; hybrid search returned on-topic, **speaker-attributed** results. Dense retrieval beat BM25 on cross-language and paraphrase queries.
- **Provenance loop** — researcher highlight → AI-drafted code (with model + prompt-hash) → endorse → `blame` shows the full AI→researcher chain.
- **export** — clean CSV with speaker/turn/word-count schema.
- **Audio pipeline** — WhisperX + pyannote produced a coherent, diarized transcript of a 52-min interview (3 speakers separated, accurate text). The hardest technical piece works.

---

## Transcription benchmark (the headline)

The transcriber runs WhisperX + pyannote inside a **Linux Docker container = CPU-only on macOS** (no Metal/GPU passthrough). That's the bottleneck: a 52-min interview took **~64 min** of compute (~1.2× realtime). Three hour-long interviews back-to-back is multi-hour — unusable in practice.

Head-to-head on a 180s clip, **large-v3-turbo**, M1 Max:

| Engine | Backend | ×realtime | Word ts | Diarization | License |
|---|---|---|---|---|---|
| Container WhisperX (VAD+ASR+diar) | Docker **CPU** | **~1.3×** | yes | pyannote | MIT / gated model |
| **MLX whisper** (`mlx-whisper`) | **Metal** | **~9.5×** | yes | — (pair w/ pyannote) | MIT |
| **whisper.cpp** | **Metal** | **~30×** (compute) | yes | tinydiarize only | MIT |
| **Parakeet-TDT 0.6B v3** (`parakeet-mlx`) | **Metal** | **~58.8×** (measured) | yes (native, per-token) | — (pair w/ pyannote) | CC-BY-4.0 |
| pyannote diarization | **CPU only** (MPS broken) | ~0.5–1× | — | — | MIT / gated |

**Finding:** native Apple-Silicon ASR is **7–45× faster** than the CPU container — and **Parakeet-TDT 0.6B is both the fastest (58.8× measured here) and the most accurate** (Open ASR English WER 6.05–6.32% vs Whisper-turbo 7.83%), with native frame-level word timestamps. Diarization (pyannote) stays CPU-bound — its MPS backend is broken (missing ops, wrong results) — so it's the real **end-to-end bottleneck regardless of ASR engine**.

**Recommendation (→ #176):** make the transcription engine **pluggable** with a native macOS ASR backend; default native on Apple Silicon, Docker as the cross-platform fallback.
- **Default: Parakeet-TDT 0.6B v3** via `parakeet-mlx` (Metal) — fastest measured (58.8×), best English WER, native word timestamps, and v3 covers **Spanish + 24 other European languages** (auto-detected). CC-BY-4.0 (attribute NVIDIA). Use v2 for English-absolute-best WER (6.05%).
- **Fallback: Whisper large-v3-turbo** via `mlx-whisper` — for languages outside Parakeet v3's 25 (Whisper covers 99: Japanese, Arabic, …) and as a long-audio cross-check (Whisper *hallucinates*; Parakeet may *truncate* — opposite failure modes).
- **Accuracy fallback (long-form): Whisper large-v3** (non-turbo) — best *open* long-form WER on the leaderboard (6.43% vs turbo's 11.0%) but slow (~RTFx 68); a quality re-run for when fidelity beats turnaround.
- **Diarization:** pyannote on **CPU** for both (MPS broken). Future max-speed option: a CoreML stack (Argmax SpeakerKit / **FluidAudio**, which bundles Parakeet + pyannote-on-ANE at ~110× on M4 Pro) — at the cost of a Swift helper, so flag it for a native app, not the Python tool.
- **Always chunk** the hour into ~2–5 min VAD-aligned overlapping segments, stitched via word timestamps — guards against long-context dropout and memory pressure (this Mac has **32 GB**, easing the research's 16 GB / 24-min single-pass caveat, but chunking stays the safe default).
- **Target:** a 1-hour interview in **≤ ~30 min** end-to-end (diarization-bound), vs ~64 today.

### Prosody / descriptive layer
No ASR engine emits pauses / speech-rate / prosody natively — they're **derived from word timestamps + a VAD**: pauses = inter-word gaps, speech rate = words/sec over voiced spans. Parakeet's **native per-token timestamps are tighter** than Whisper's heuristic (attention/DTW) ones, which makes pause/speech-rate derivation and pyannote word→speaker alignment cleaner. Optionally add a Praat/Parselmouth pass for pitch/energy.

### Meta Seamless — evaluated, not a fit
Requested for the benchmark. Conclusion: **it regresses the descriptive layer.**
- **SeamlessExpressive** is expressive **speech-to-speech translation** that preserves prosody *in output audio* — it does **not** transcribe (no text/timestamps/diarization), is double-gated (Meta form + HF) under a custom non-commercial license.
- **SeamlessM4T** *can* do ASR but emits a **bare untimed string** (no word timing, no speakers), is CC-BY-NC (non-commercial), and runs poorly on Apple Silicon (MPS CPU-fallback, OOM-prone, ~20s chunking).
- The only reusable nugget is its standalone `stopes/eval/local_prosody` rate/pause scorer — a side utility, not the model. **Stay on Parakeet/Whisper ASR + pyannote.**

### Leaderboard check (Open ASR Leaderboard, Mar 2026 — 86 models)
Verified the recommendation against the live leaderboard. Filtering by compost's constraints (local / no API key, Apple-Silicon, Python, word timestamps, multilingual incl. Spanish, permissive license) eliminates two whole tiers:
- **Proprietary API leaders** (Cohere, ElevenLabs Scribe v2, AssemblyAI, Zoom, Speechmatics) top every track but need API keys → out (they're also ~3 WER points better on long-form — the honest open-vs-cloud gap).
- **Large open LLM-decoder models** (Canary-Qwen 2.5B, IBM Granite 1–8B, Qwen3-ASR, Phi-4, Voxtral 24B, Omnilingual 7B) lead short-form English but are CUDA-oriented, 10–100× slower, with weak/no word timestamps → not convenient on a local Mac.

What survives the filter is exactly **Parakeet 0.6B (v3/v2) + Whisper (turbo/v3)** — the convenient set above. On the **long-form** track (compost's real use case) Parakeet v3 (10.7% WER, RTFx 1000) ≈ Whisper-turbo accuracy at ~7× the speed.

**Honorable mention — CrisperWhisper:** descriptively ideal (verbatim fillers `[UM]`/`[UH]`, best pause/word-timestamp F1 — exactly compost's descriptive goal) but **not an engine here**: English/German only, CC-BY-NC (non-commercial), no Apple-Silicon path. Its DTW-timestamp + disfluency approach is the **reference design for compost's descriptive layer**, not the transcriber.

---

## Consolidated fixes (milestone v0.1.1)

### P0 — breaks the documented flow / core promises
| # | Fix |
|---|---|
| #160 | `compost chat` requires a cloud API key (routes to the `synthesis` task) → use a local model |
| #161 | Tutorial + `--help` present stubbed `query` (#51) / `synthesize` (#59) as working |
| #162 | Transcriber image has no freshness/version check — stale cached image 404s on newer routes |
| #163 | Dockerized ingest can't see seeds outside `<repo>/Seeds` + host→container path mismatch |
| #176 | Add a Mac-native (Metal/MLX) transcription backend — Docker CPU is too slow |

### P1 — correctness / trust
| # | Fix |
|---|---|
| #164 | `watch --once` reports failed jobs as success (`processed:N, status:ok`) |
| #165 | `create … --ai` is non-atomic — orphans the markdown when event validation fails |
| #166 | `saturate` counts non-canonical folders as sessions (disagrees with `status`) |
| #177 | Map diarized speakers to real names (speaker-labeling step) |

### P2 — UX / consistency / quality
| # | Fix |
|---|---|
| #167 | Seed-scoped commands missing `--seed` (`query`, `synthesize`) |
| #168 | `endorse`/`blame` reject the human id that `create` returns |
| #169 | `endorse` is not idempotent (duplicate endorse events) |
| #170 | Retrieval returns near-duplicate chunks — add result-level dedup/MMR |
| #171 | `tag` produces low-value terms — no stopword filtering, ingests noise |
| #172 | No importer for existing text transcripts (speaker + timestamp `.txt`) |
| #173 | Human-readable CLI output mode (default is machine-JSON) |
| #174 | `validate` has no `transcript.json` / whole-seed subcommand |
| #175 | `doctor`/config — reconcile configured default models with pulled models |
| #178 | Diarization over-segments — spurious low-count speakers + `S?` orphans |
| #179 | Transcriber output omits `kind: "session"` |
| #180 | `language` hint ignored — WhisperX auto-detects despite language set |

---

## Recommended sequencing

1. **Unblock the loop (P0 answer path):** #160 (local chat) → #161 (stub honesty). Smallest, restores the no-key promise.
2. **Make ingest real (P0):** #176 (native fast transcription) + #163 (external-seed mounts) + #162 (image freshness). These together make the audio path usable for a researcher whose seeds live in a vault.
3. **Trust (P1):** #164, #165, #166, #177.
4. **Quality polish (P2):** batch the rest; #170/#171/#172/#178 most affect real-data UX.

Then re-dogfood the full flow before resuming v0.2.
