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

The transcriber ran WhisperX + pyannote inside a **Linux Docker container = CPU-only on macOS** (no Metal/GPU passthrough). That was the bottleneck: a 52-min interview took **~64 min** of compute. **#176 (implemented + validated on the certification seed)** moves transcription to a native Apple-Silicon path and is **~20× faster end-to-end**. Numbers below are consistent **×realtime = audio ÷ compute** (higher = faster; <1 = slower than realtime), all measured on this M1 Max.

**ASR stage (180s clip, large-v3-turbo unless noted):**

| Engine | Backend | ×realtime (ASR) | Word ts | License |
|---|---|---|---|---|
| WhisperX (faster-whisper) | Docker **CPU** | (part of ~0.8× full) | yes | MIT |
| MLX whisper (`mlx-whisper`) | **Metal** | **9.5×** | yes | MIT |
| whisper.cpp | **Metal** | **~30×** | yes | MIT |
| **Parakeet-TDT 0.6B v3** (`parakeet-mlx`) | **Metal** | **58.8×** | yes (native, per-token) | CC-BY-4.0 |

**Diarization stage (pyannote 3.1, 120s clip) — the real bottleneck:**

| Device | ×realtime | Result vs CPU |
|---|---|---|
| CPU | ~0.7–1.4× | baseline |
| **MPS (Metal)** | **25.8×** | **byte-identical** (same speakers, turns, per-speaker seconds) |

**Full pipeline, end-to-end, on real hour-long interviews (measured):**

| Path | ×realtime | 60-min interview |
|---|---|---|
| Container WhisperX + pyannote-CPU | ~0.8× | ~64–77 min |
| **Native Parakeet + Silero + pyannote-MPS** | **~16×** | **~3.5 min** |

**Findings:**
1. **Native ASR is 7–45× faster**, and **Parakeet-TDT 0.6B is the fastest (58.8×) and most accurate** (Open ASR English WER 6.05–6.32% vs Whisper-turbo 7.83%), with native frame-level word timestamps.
2. **The decisive unlock is pyannote on MPS, not the ASR engine.** Diarization dominates the pipeline — on CPU it's ~1× realtime, so a native-ASR-but-CPU-diar pipeline is *no faster* than Docker. On **MPS (Metal)** pyannote runs **~18–25× faster with byte-identical results**. The earlier research's "MPS broken" claim is **outdated** (older torch); **verified correct on torch 2.12**. Running diarization on MPS is what makes native a true **~20× end-to-end win**.
3. **Long files must be chunked.** parakeet-mlx loads the whole file into one Metal buffer; a 60-min file tried to allocate **~131 GB** (Metal cap ~20 GB) and failed. Chunking at ~2 min (parakeet stitches via 15s overlap + token timestamps) fixes it.
4. **Head-to-head on the certification seed** (Parakeet-native vs the WhisperX-Docker transcripts): ~20× faster, **equivalent text**, *cleaner* segmentation (fewer/longer utterances, no `S?` orphan on S001). The 6-speaker over-diarization on one interview appears in **both** → a pyannote concern (#178), not engine-specific.

**Recommendation (→ #176, implemented):** pluggable transcription engine + runtime; native on Apple Silicon, Docker as the cross-platform fallback.
- **Default: Parakeet-TDT 0.6B v3** via `parakeet-mlx` (Metal) — fastest, native word timestamps, covers **Spanish + 24 other European languages**. CC-BY-4.0. v2 for English-absolute-best WER (6.05%).
- **Fallback: Whisper large-v3-turbo** (`mlx-whisper`) for languages outside Parakeet v3's 25 (Whisper covers 99) and as a long-audio cross-check; **Whisper large-v3** (non-turbo) for best long-form WER when fidelity beats turnaround.
- **Diarization: pyannote on MPS** (Metal) on Apple Silicon — verified correct + ~18× faster than CPU on torch≥2.12; CPU elsewhere. (CoreML / FluidAudio stays a future Swift option for a further ~5×.)
- **Always chunk** long files (~2 min) to stay within Metal's buffer cap.
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
