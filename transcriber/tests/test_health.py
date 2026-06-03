"""Unit tests for the /health endpoint.

Heavy ML deps (whisperx, pyannote.audio, silero-vad) are intentionally not
installed in the base image; their versions in the response are `None` until
the corresponding issues (#9-#15) bring them in.
"""

from __future__ import annotations

import sys

from fastapi.testclient import TestClient

from app.main import create_app


def test_health_returns_ok():
    client = TestClient(create_app())
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "compost-transcriber"


def test_health_reports_runtime_versions():
    client = TestClient(create_app())
    body = client.get("/health").json()
    versions = body["versions"]
    assert versions["transcriber"] == "0.0.0"
    # python version is whatever the test runtime is, not pinned
    assert versions["python"].startswith(f"{sys.version_info.major}.{sys.version_info.minor}")
    # fastapi must be present (the service depends on it)
    assert versions["fastapi"] is not None


def test_health_reports_missing_ml_deps_as_null_until_issues_9_through_15_land():
    client = TestClient(create_app())
    body = client.get("/health").json()
    assert body["versions"]["whisperx"] is None
    assert body["versions"]["pyannote.audio"] is None
    assert body["versions"]["silero-vad"] is None
