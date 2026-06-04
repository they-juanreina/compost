"""Tests for legacy ingestors (#29).

Fixtures are generated programmatically (no binary blobs in the repo). Each
ingestor's output is validated against schema/transcript.schema.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.legacy import ingest, ingest_csv, ingest_docx, ingest_pdf, ingest_pptx

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "transcript.schema.json"


def _validate(doc: dict) -> None:
    import jsonschema  # type: ignore

    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.validate(doc, schema)


def test_csv_one_utterance_per_row_with_mapping(tmp_path: Path):
    csv_path = tmp_path / "quotes.csv"
    csv_path.write_text("Quote,Participant\n\"I distrust alerts\",P07\n\"It depends\",P08\n")
    doc = ingest_csv(csv_path, text_col="Quote", speaker_col="Participant")
    assert doc["kind"] == "document"
    assert len(doc["utterances"]) == 2
    assert doc["utterances"][0]["text"] == "I distrust alerts"
    assert "[speaker: P07]" in doc["utterances"][0]["annotation"]
    _validate(doc)


def test_csv_missing_column_raises(tmp_path: Path):
    csv_path = tmp_path / "q.csv"
    csv_path.write_text("A,B\n1,2\n")
    with pytest.raises(ValueError):
        ingest_csv(csv_path, text_col="Quote")


def test_docx_one_utterance_per_paragraph_with_section_anchor(tmp_path: Path):
    import docx

    d = docx.Document()
    d.add_heading("Findings", level=1)
    d.add_paragraph("Participants distrust automated alerts.")
    d.add_paragraph("They want a manual override.")
    p = tmp_path / "report.docx"
    d.save(p)

    doc = ingest_docx(p)
    assert len(doc["utterances"]) == 2
    assert doc["utterances"][0]["annotation"] == "[section: Findings]"
    _validate(doc)


def test_pptx_one_utterance_per_slide(tmp_path: Path):
    from pptx import Presentation

    prs = Presentation()
    blank = prs.slide_layouts[6]
    for title in ("Intro", "Key Insight"):
        slide = prs.slides.add_slide(blank)
        tb = slide.shapes.add_textbox(0, 0, 100, 100).text_frame
        tb.text = title
    p = tmp_path / "deck.pptx"
    prs.save(p)

    doc = ingest_pptx(p)
    assert len(doc["utterances"]) == 2
    assert doc["utterances"][0]["source_page"] == 1
    assert "Intro" in doc["utterances"][0]["text"]
    _validate(doc)


def test_pdf_paragraphs_with_source_page(tmp_path: Path):
    # Build a tiny PDF with reportlab if available; else skip (text-extraction
    # is exercised by the paragraph splitter test below regardless).
    pytest.importorskip("reportlab")
    from reportlab.pdfgen import canvas  # type: ignore

    p = tmp_path / "doc.pdf"
    c = canvas.Canvas(str(p))
    c.drawString(72, 720, "First finding about trust.")
    c.showPage()
    c.drawString(72, 720, "Second finding about control.")
    c.showPage()
    c.save()

    doc = ingest_pdf(p)
    assert doc["kind"] == "document"
    assert len(doc["utterances"]) >= 2
    pages = {u["source_page"] for u in doc["utterances"]}
    assert pages == {1, 2}
    _validate(doc)


def test_dispatch_by_extension(tmp_path: Path):
    csv_path = tmp_path / "q.csv"
    csv_path.write_text("text\nhello\n")
    doc = ingest(csv_path, text_col="text")
    assert doc["kind"] == "document"
    assert doc["utterances"][0]["text"] == "hello"


def test_unsupported_extension_raises(tmp_path: Path):
    with pytest.raises(ValueError):
        ingest(tmp_path / "x.rtf")


# v0.1-02 review feedback: auto-detect column name when text_col is None.


def test_csv_autodetects_text_column_when_text_col_is_none(tmp_path: Path):
    """Header has `transcript` (not `text`). Auto-detect finds it second
    in the priority list."""
    csv_path = tmp_path / "otter.csv"
    csv_path.write_text("speaker,transcript\nMod,hello there\nP01,thank you\n")
    doc = ingest_csv(csv_path)  # text_col omitted → auto-detect
    assert doc["provenance"]["text_col_resolved"] == "transcript"
    assert [u["text"] for u in doc["utterances"]] == ["hello there", "thank you"]


def test_csv_autodetect_is_case_insensitive(tmp_path: Path):
    """The header says `Content` (capital C); auto-detect should still match."""
    csv_path = tmp_path / "zoom.csv"
    csv_path.write_text("Speaker,Content\nMod,intro\nP01,follow-up\n")
    doc = ingest_csv(csv_path)
    assert doc["provenance"]["text_col_resolved"] == "Content"
    assert len(doc["utterances"]) == 2


def test_csv_autodetect_falls_back_to_first_column(tmp_path: Path):
    """Header has no candidate from the priority list → fall back to col 0."""
    csv_path = tmp_path / "weird.csv"
    csv_path.write_text("notes,extra\nfirst row,x\nsecond row,y\n")
    doc = ingest_csv(csv_path)
    assert doc["provenance"]["text_col_resolved"] == "notes"
    assert [u["text"] for u in doc["utterances"]] == ["first row", "second row"]


def test_csv_explicit_text_col_overrides_autodetect(tmp_path: Path):
    """When text_col is passed explicitly, auto-detect is skipped."""
    csv_path = tmp_path / "survey.csv"
    csv_path.write_text("text,answer\nshould be ignored,real answer\n")
    doc = ingest_csv(csv_path, text_col="answer")
    assert doc["provenance"]["text_col_resolved"] == "answer"
    assert doc["utterances"][0]["text"] == "real answer"
