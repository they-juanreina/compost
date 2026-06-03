FROM python:3.11-slim-bookworm AS base

# ffmpeg is required by every audio/video pipeline that will land in
# #9-#15. Tesseract is required by the legacy PDF ingestor (#29).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        tesseract-ocr \
        libsndfile1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Drop privileges. /app is owned by the unprivileged user; /seeds is the
# bind-mount target for the host's Seeds/ tree.
RUN useradd --create-home --shell /bin/bash compost
WORKDIR /app

# Install Python deps first for layer caching.
COPY --chown=compost:compost pyproject.toml /app/pyproject.toml
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e .

COPY --chown=compost:compost app /app/app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    COMPOST_SEEDS_ROOT=/seeds

USER compost

EXPOSE 7862

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://localhost:7862/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7862"]
