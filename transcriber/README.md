# transcriber

Python FastAPI service inside OrbStack. WhisperX + pyannote + Silero VAD + Whisper-event-tags for descriptive audio; ffmpeg + perceptual-hash shot-change for screenshot capture; optional Moondream2 for frame annotation; PDF/DOCX/PPTX/CSV legacy ingest.

See [ROADMAP.md § Descriptive transcription + screenshot capture](../ROADMAP.md#descriptive-transcription--screenshot-capture).

## Run

First-time prerequisites (one-time):

1. **HuggingFace token** for pyannote diarization:
   - Create a token at <https://huggingface.co/settings/tokens>
   - Accept the license at <https://huggingface.co/pyannote/speaker-diarization-3.1>
   - Export it: `export HUGGINGFACE_TOKEN=hf_...` (or put it in `.env.local` at the repo root)

2. **Start the container**:
   ```sh
   docker compose -f transcriber/compose.yaml up --build
   curl http://localhost:7862/health
   ```

The container bind-mounts `../Seeds` at `/seeds` so workers can write transcripts, frames, and legacy artifacts back to the host tree. A named volume `compost-models` caches the multi-GB Whisper + pyannote weights so subsequent runs are offline.

## Transcribe a session

```sh
curl -X POST http://localhost:7862/transcribe \
  -H 'Content-Type: application/json' \
  -d '{
    "seed_path": "/seeds/<seed-name>",
    "session_id": "S001",
    "source_path": "/seeds/<seed-name>/sessions/S001/source.mp3",
    "language": "es-CO"
  }'
```

Or from the host, via the CLI: `compost transcribe S001 --seed <seed-name>`.

## Develop

```sh
cd transcriber
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e .
pip install pytest httpx
uvicorn app.main:app --reload --port 7862
pytest
```

## What's in here vs. coming

| What | Issue | Status |
|---|---|---|
| FastAPI skeleton + /health | #4 | shipped |
| **POST /transcribe (orchestrates the full pipeline)** | **v0.1-01** | **shipped** |
| **WhisperXBackend (concrete ASR backend)** | **v0.1-01** | **shipped** |
| **PyannoteBackend (concrete diarization backend)** | **v0.1-01** | **shipped** |
| Silero VAD + silence segmentation (deterministic core) | #9 | shipped (core); concrete backend impl in v0.1-01 |
| Whisper-large-v3 with event tags | #10 | shipped (core); WhisperX concrete in v0.1-01 |
| pyannote diarization | #11 | shipped (core); concrete in v0.1-01 |
| Silence typer (after_question, …) | #12 | shipped |
| Prosody hint extractor | #13 | shipped |
| ffmpeg trigger-based frame extractor | #14 | core shipped; auto-snap loop in v0.2-12 |
| Perceptual-hash shot-change | #15 | core shipped |
| Frame annotation (vision LLM) | #50 | pending (off by default in v0.1) |
| PDF/DOCX/PPTX/CSV legacy ingest | #29 / v0.1-02 | core shipped; route + worker in v0.1-02 |
