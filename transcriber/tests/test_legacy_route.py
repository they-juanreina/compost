"""Integration tests for POST /legacy-ingest (v0.1-02).

The Python ingestors themselves are unit-tested in test_legacy.py. These tests
cover the HTTP surface: error mapping, output file placement, status codes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture
def seed_dir(tmp_path: Path) -> Path:
    seed = tmp_path / "Seeds" / "demo"
    seed.mkdir(parents=True)
    return seed


def test_csv_ingest_writes_legacy_json(client: TestClient, seed_dir: Path) -> None:
    src = seed_dir / "fact_utterances.csv"
    src.write_text(
        "text,speaker\n"
        "Hello there,Mod\n"
        "I never just trust the alert,P01\n"
        "I verify manually,P01\n",
        encoding="utf-8",
    )
    res = client.post(
        "/legacy-ingest",
        json={
            "seed_path": str(seed_dir),
            "source_path": str(src),
            "text_col": "text",
            "speaker_col": "speaker",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["utterance_count"] == 3
    assert body["status"] == "ok"

    out_path = Path(body["normalized_path"])
    assert out_path.exists()
    doc = json.loads(out_path.read_text())
    assert doc["schema_version"] == "1.0"
    assert doc["kind"] == "document"
    assert doc["modality"] == ["document"]
    assert len(doc["utterances"]) == 3
    # speaker_col landed as annotation
    assert "[speaker: Mod]" in doc["utterances"][0]["annotation"]


def test_txt_ingest_paragraph_split(client: TestClient, seed_dir: Path) -> None:
    src = seed_dir / "Otter-export.txt"
    src.write_text(
        "# Session 1\n\n"
        "Speaker A: First paragraph here.\n\n"
        "Second paragraph here.\n",
        encoding="utf-8",
    )
    res = client.post(
        "/legacy-ingest",
        json={"seed_path": str(seed_dir), "source_path": str(src)},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["utterance_count"] == 2
    doc = json.loads(Path(body["normalized_path"]).read_text())
    # The heading became a section annotation; not a separate utterance.
    assert all("Speaker A" in u["text"] or "Second paragraph" in u["text"] for u in doc["utterances"])
    assert all("[section: Session 1]" in (u.get("annotation") or "") for u in doc["utterances"])


def test_404_on_missing_source(client: TestClient, seed_dir: Path) -> None:
    res = client.post(
        "/legacy-ingest",
        json={
            "seed_path": str(seed_dir),
            "source_path": str(seed_dir / "ghost.csv"),
        },
    )
    assert res.status_code == 404
    assert "source not found" in res.json()["detail"]


def test_404_on_missing_seed(client: TestClient, tmp_path: Path) -> None:
    src = tmp_path / "a.csv"
    src.write_text("text\nhi\n", encoding="utf-8")
    res = client.post(
        "/legacy-ingest",
        json={
            "seed_path": str(tmp_path / "Seeds" / "ghost"),
            "source_path": str(src),
        },
    )
    assert res.status_code == 404
    assert "seed not found" in res.json()["detail"]


def test_422_on_unsupported_extension(client: TestClient, seed_dir: Path) -> None:
    src = seed_dir / "archive.zip"
    src.write_text("", encoding="utf-8")
    res = client.post(
        "/legacy-ingest",
        json={"seed_path": str(seed_dir), "source_path": str(src)},
    )
    assert res.status_code == 422
    assert "invalid_input" in res.json()["detail"]


def test_empty_csv_returns_status_empty(client: TestClient, seed_dir: Path) -> None:
    src = seed_dir / "empty.csv"
    src.write_text("text,speaker\n", encoding="utf-8")  # header only
    res = client.post(
        "/legacy-ingest",
        json={"seed_path": str(seed_dir), "source_path": str(src)},
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "empty"
    assert res.json()["utterance_count"] == 0
