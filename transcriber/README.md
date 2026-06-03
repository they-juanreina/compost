# transcriber

Python FastAPI service inside OrbStack. WhisperX + pyannote + Silero VAD + Whisper-event-tags for descriptive audio; ffmpeg + perceptual-hash shot-change for screenshot capture; optional Moondream2 for frame annotation; PDF/DOCX/PPTX/CSV legacy ingest.

See [ROADMAP.md § Descriptive transcription + screenshot capture](../ROADMAP.md#descriptive-transcription--screenshot-capture).

## Run

```sh
docker compose -f transcriber/compose.yaml up --build
curl http://localhost:7862/health
```

The container bind-mounts `../Seeds` at `/seeds` so workers can write transcripts, frames, and legacy artifacts back to the host tree.

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
| Silero VAD + silence segmentation | #9 | pending |
| Whisper-large-v3 with event tags | #10 | pending |
| pyannote diarization | #11 | pending |
| Silence typer (after_question, …) | #12 | pending |
| Prosody hint extractor | #13 | pending |
| ffmpeg trigger-based frame extractor | #14 | pending |
| Perceptual-hash shot-change | #15 | pending |
| Frame annotation (vision LLM) | #50 | pending |
| PDF/DOCX/PPTX/CSV legacy ingest | #29 | pending |
