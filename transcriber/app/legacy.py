"""Legacy asset ingestors (#29).

Normalize PDF / DOCX / PPTX / CSV into a transcript-shaped JSON with
kind="document": one utterance per paragraph (PDF/DOCX), per slide (PPTX),
or per row (CSV). Output validates against schema/transcript.schema.json
(kind="document", modality=["document"]).

Heavy parsers (pdfplumber, python-docx, python-pptx) are imported lazily so
the module loads without the `legacy` extra; each ingestor raises a clear
error if its dependency is missing.
"""

from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any

INGESTOR_VERSION = "compost-legacy@0.1.0"
DOC_SPEAKER = {"id": "S1", "name": "document", "type": "other"}


def _base(session_id: str, source: str, language: str = "und") -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "kind": "document",
        "session_id": session_id,
        "source": source,
        "language": language,
        "duration_ms": 0,
        "modality": ["document"],
        "speakers": [dict(DOC_SPEAKER)],
        "utterances": [],
        "provenance": {"transcriber": INGESTOR_VERSION},
    }


def _utt(idx: int, text: str, source_page: int | None = None, annotation: str | None = None) -> dict[str, Any]:
    u: dict[str, Any] = {
        "id": f"U-{idx:04d}",
        "speaker_id": DOC_SPEAKER["id"],
        "turn": idx,
        "start_ms": 0,
        "end_ms": 0,
        "text": text,
    }
    if source_page is not None:
        u["source_page"] = source_page
    if annotation is not None:
        u["annotation"] = annotation
    return u


def _session_id(path: str | Path) -> str:
    stem = Path(path).stem
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in stem)
    return f"DOC-{safe}"[:64]


# ---------------------------------------------------------------- CSV / XLSX

# Auto-detect priority for the "text" column. First case-insensitive match
# in the source's header wins. Falls back to the first column.
TEXT_COL_CANDIDATES = (
    "text",
    "transcript",
    "content",
    "utterance",
    "quote",
    "message",
    "body",
)


def _auto_text_col(fieldnames: list[str]) -> str:
    """Pick the most-likely text column from a header. Case-insensitive match
    against TEXT_COL_CANDIDATES, then a first-column fallback."""
    lower = {f.lower(): f for f in fieldnames}
    for candidate in TEXT_COL_CANDIDATES:
        if candidate in lower:
            return lower[candidate]
    return fieldnames[0]


def ingest_csv(
    path: str | Path,
    text_col: str | None = None,
    speaker_col: str | None = None,
) -> dict[str, Any]:
    """One utterance per row.

    `text_col=None` triggers auto-detect: text → transcript → content →
    utterance → quote → message → body (case-insensitive). Falls back to
    the first column. The resolved column is recorded on the output's
    `provenance.text_col_resolved` for caller visibility.
    """
    path = str(path)
    doc = _base(_session_id(path), path)
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError(f"CSV has no header row: {path}")
        fields = list(reader.fieldnames)
        resolved = text_col if text_col is not None else _auto_text_col(fields)
        if resolved not in fields:
            raise ValueError(f"CSV has no column '{resolved}' (columns: {fields})")
        doc["provenance"]["text_col_resolved"] = resolved
        idx = 1
        for row in reader:
            text = (row.get(resolved) or "").strip()
            if not text:
                continue
            ann = None
            if speaker_col is not None and row.get(speaker_col):
                ann = f"[speaker: {row[speaker_col]}]"
            doc["utterances"].append(_utt(idx, text, source_page=idx, annotation=ann))
            idx += 1
    return doc


# ---------------------------------------------------------------- DOCX


def ingest_docx(path: str | Path) -> dict[str, Any]:
    try:
        import docx  # type: ignore
    except ImportError as e:
        raise RuntimeError("python-docx not installed (pip install -e '.[legacy]')") from e

    path = str(path)
    doc = _base(_session_id(path), path)
    d = docx.Document(path)
    idx = 1
    current_heading: str | None = None
    for para in d.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if style.startswith("heading"):
            current_heading = text
            # headings preserved as section anchors via annotation on the next utterances
            continue
        ann = f"[section: {current_heading}]" if current_heading else None
        doc["utterances"].append(_utt(idx, text, annotation=ann))
        idx += 1
    return doc


# ---------------------------------------------------------------- PPTX


def ingest_pptx(path: str | Path, thumbnails_dir: str | Path | None = None) -> dict[str, Any]:
    try:
        from pptx import Presentation  # type: ignore
    except ImportError as e:
        raise RuntimeError("python-pptx not installed (pip install -e '.[legacy]')") from e

    path = str(path)
    doc = _base(_session_id(path), path)
    prs = Presentation(path)
    idx = 1
    for slide_no, slide in enumerate(prs.slides, start=1):
        parts: list[str] = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for p in shape.text_frame.paragraphs:
                    line = "".join(run.text for run in p.runs).strip()
                    if line:
                        parts.append(line)
        notes = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text.strip()
        if notes:
            parts.append(f"(notes) {notes}")
        text = "\n".join(parts)
        if text:
            doc["utterances"].append(_utt(idx, text, source_page=slide_no))
            idx += 1
    # Thumbnail rendering requires LibreOffice/unoconv (not bundled); skipped
    # gracefully. The slide text above is the load-bearing evidence.
    if thumbnails_dir is not None:
        os.makedirs(thumbnails_dir, exist_ok=True)
    return doc


# ---------------------------------------------------------------- PDF


def ingest_pdf(path: str | Path) -> dict[str, Any]:
    try:
        import pdfplumber  # type: ignore
    except ImportError as e:
        raise RuntimeError("pdfplumber not installed (pip install -e '.[legacy]')") from e

    path = str(path)
    doc = _base(_session_id(path), path)
    idx = 1
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            # OCR fallback for scanned pages (no extractable text) requires
            # pytesseract + the page raster; attempted best-effort.
            if not text.strip():
                text = _ocr_page(page)
            for para in _paragraphs(text):
                doc["utterances"].append(_utt(idx, para, source_page=page_no))
                idx += 1
    return doc


def _paragraphs(text: str) -> list[str]:
    out: list[str] = []
    for block in text.split("\n\n"):
        cleaned = " ".join(line.strip() for line in block.splitlines() if line.strip())
        if cleaned:
            out.append(cleaned)
    return out


def _ocr_page(page: Any) -> str:  # pragma: no cover - needs tesseract + a raster
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore  # noqa: F401
    except ImportError:
        return ""
    try:
        im = page.to_image(resolution=200).original
        return pytesseract.image_to_string(im)
    except Exception:
        return ""


# ---------------------------------------------------------------- Markdown / Text


def ingest_text(path: str | Path) -> dict[str, Any]:
    """Read a plain-text or Markdown file and split into paragraph utterances.

    Both `.txt` (Otter / Zoom exports) and `.md` land here. Top-level
    headings are recorded as section annotations on subsequent utterances,
    mirroring the docx behavior.
    """
    path = str(path)
    doc = _base(_session_id(path), path)
    with open(path, encoding="utf-8") as f:
        body = f.read()

    current_heading: str | None = None
    idx = 1
    for para in _paragraphs(body):
        # Markdown heading line → record as section anchor, skip the utterance.
        if para.startswith(("# ", "## ", "### ", "#### ")):
            current_heading = para.lstrip("# ").strip()
            continue
        ann = f"[section: {current_heading}]" if current_heading else None
        doc["utterances"].append(_utt(idx, para, annotation=ann))
        idx += 1
    return doc


# ---------------------------------------------------------------- XLSX


def ingest_xlsx(
    path: str | Path,
    text_col: str | None = None,
    speaker_col: str | None = None,
    sheet: str | None = None,
) -> dict[str, Any]:
    """One utterance per row of a spreadsheet.

    `text_col=None` triggers the same auto-detect as `ingest_csv`. The
    resolved column lands on `provenance.text_col_resolved`. Use `sheet`
    to pick a non-default tab.
    """
    try:
        from openpyxl import load_workbook  # type: ignore
    except ImportError as e:
        raise RuntimeError("openpyxl not installed (pip install -e '.[legacy]')") from e

    path = str(path)
    doc = _base(_session_id(path), path)
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet] if sheet is not None else wb.active
    if ws is None:
        raise ValueError(f"XLSX has no worksheets: {path}")

    rows = ws.iter_rows(values_only=True)
    header_row = next(rows, None)
    if header_row is None:
        return doc  # empty sheet
    header = [str(c) if c is not None else "" for c in header_row]
    resolved = text_col if text_col is not None else _auto_text_col(header)
    if resolved not in header:
        raise ValueError(f"XLSX has no column '{resolved}' (columns: {header})")
    doc["provenance"]["text_col_resolved"] = resolved
    text_idx = header.index(resolved)
    speaker_idx = header.index(speaker_col) if speaker_col in header else -1

    utt_idx = 1
    for row in rows:
        if row is None:
            continue
        cell = row[text_idx] if text_idx < len(row) else None
        text = str(cell).strip() if cell is not None else ""
        if not text:
            continue
        ann = None
        if speaker_idx >= 0 and speaker_idx < len(row) and row[speaker_idx] is not None:
            ann = f"[speaker: {row[speaker_idx]}]"
        doc["utterances"].append(_utt(utt_idx, text, source_page=utt_idx, annotation=ann))
        utt_idx += 1
    return doc


def ingest(path: str | Path, **kwargs: Any) -> dict[str, Any]:
    """Dispatch by extension. `text_col=None` (the default) triggers
    auto-detect on CSV/XLSX inputs."""
    ext = Path(path).suffix.lower()
    if ext == ".csv":
        return ingest_csv(
            path,
            text_col=kwargs.get("text_col"),
            speaker_col=kwargs.get("speaker_col"),
        )
    if ext == ".docx":
        return ingest_docx(path)
    if ext == ".pptx":
        return ingest_pptx(path, thumbnails_dir=kwargs.get("thumbnails_dir"))
    if ext == ".pdf":
        return ingest_pdf(path)
    if ext in (".txt", ".md", ".markdown"):
        return ingest_text(path)
    if ext == ".xlsx":
        return ingest_xlsx(
            path,
            text_col=kwargs.get("text_col"),
            speaker_col=kwargs.get("speaker_col"),
            sheet=kwargs.get("sheet"),
        )
    raise ValueError(f"Unsupported legacy asset: {ext}")
