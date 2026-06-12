"""Native (host) legacy-ingest entrypoint (#184).

Mirrors `app.transcribe_cli` for documents: runs the pure ingestors in
`app.legacy.ingest` in a host Python venv so PDF/DOCX/PPTX/CSV/XLSX/TXT ingest
works WITHOUT the Docker transcriber (demoted to a fallback). Shares the exact
write + response shape as the `/legacy-ingest` route so the Node legacy-worker
treats native and Docker results identically.

Usage:
    python -m app.legacy_cli --seed-path <seed> --source-path <file> \
        [--text-col COL] [--speaker-col COL] [--sheet NAME]
Prints exactly one JSON line; exit 0 on ok/empty, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .legacy import ingest as ingest_legacy


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="compost-legacy-native")
    p.add_argument("--seed-path", required=True)
    p.add_argument("--source-path", required=True)
    p.add_argument("--text-col", default=None)
    p.add_argument("--speaker-col", default=None)
    p.add_argument("--sheet", default=None)
    # Source/author attribution for sourced documents (#270): standpoint without
    # a speaker. Any subset; recorded under the transcript's `attribution`.
    p.add_argument("--author", default=None)
    p.add_argument("--title", default=None)
    p.add_argument("--year", default=None)
    p.add_argument("--url", default=None)
    # Structured (CSL-flavored) citation (#270). --citation is the free-form raw
    # fallback; the rest populate the structured citation object.
    p.add_argument("--citation", default=None, help="Free-form citation (citation.raw)")
    p.add_argument("--citation-type", default=None, help="CSL type, e.g. interview, book")
    p.add_argument("--container", default=None, help="Journal/book/anthology title")
    p.add_argument("--editors", default=None, help="Comma-separated editor names")
    p.add_argument("--pages", default=None)
    p.add_argument("--doi", default=None)
    args = p.parse_args(argv)

    src = Path(args.source_path)
    seed = Path(args.seed_path)
    if not src.exists():
        print(json.dumps({"status": "failed", "kind": "invalid_input", "error": f"source not found: {src}"}))
        return 1
    if not seed.exists():
        print(json.dumps({"status": "failed", "kind": "invalid_input", "error": f"seed not found: {seed}"}))
        return 1

    kwargs: dict[str, Any] = {}
    if args.text_col is not None:
        kwargs["text_col"] = args.text_col
    if args.speaker_col is not None:
        kwargs["speaker_col"] = args.speaker_col
    if args.sheet is not None:
        kwargs["sheet"] = args.sheet
    citation: dict[str, Any] = {
        k: v
        for k, v in (
            ("raw", args.citation),
            ("type", args.citation_type),
            ("container_title", args.container),
            ("pages", args.pages),
            ("doi", args.doi),
        )
        if v is not None
    }
    if args.editors is not None:
        eds = [e.strip() for e in args.editors.split(",") if e.strip()]
        if eds:
            citation["editors"] = eds
    attribution: dict[str, Any] = {
        k: v
        for k, v in (
            ("author", args.author),
            ("title", args.title),
            ("year", args.year),
            ("url", args.url),
        )
        if v is not None
    }
    if citation:
        attribution["citation"] = citation
    if attribution:
        kwargs["attribution"] = attribution

    try:
        doc = ingest_legacy(src, **kwargs)
    except ValueError as e:  # unsupported ext / missing column
        print(json.dumps({"status": "failed", "kind": "invalid_input", "error": str(e)}))
        return 1
    except RuntimeError as e:  # missing optional dep (python-docx, openpyxl, …)
        print(json.dumps({"status": "failed", "kind": "dep_missing", "error": str(e)}))
        return 1

    legacy_dir = seed / "legacy"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    out_path = legacy_dir / f"{src.stem}.json"
    out_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    utt_count = len(doc.get("utterances", []))
    prov = doc.get("provenance", {})
    warnings: list[str] = []
    skipped = prov.get("xlsx_rows_skipped_empty_text", 0)
    if skipped > 0:
        warnings.append(
            f"{skipped} XLSX row(s) had data in other columns but an empty text cell — "
            "likely an un-evaluated formula. Open the file in Excel once, or export to CSV."
        )

    print(
        json.dumps(
            {
                "status": "ok" if utt_count > 0 else "empty",
                "source_path": str(src),
                "normalized_path": str(out_path),
                "utterance_count": utt_count,
                "text_col_resolved": prov.get("text_col_resolved"),
                "warnings": warnings,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
