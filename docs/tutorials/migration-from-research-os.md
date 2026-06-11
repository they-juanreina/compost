# Tutorial: migrating from research-os

`compost migrate` brings a legacy `01_Plan / 02_Sessions / 03_Synthesis /
04_Evaluation` seed into the compost layout in place.

## 1. Dry-run first (read-only, the default)

```sh
compost migrate "/path/to/Research_OS2/Seeds/Data Hub Foundational"
```

Prints the rename plan and the scaffold it would add — touches nothing:

```json
{
  "status": "dry_run",
  "renames": [
    { "from": "01_Plan", "to": "plan" },
    { "from": "02_Sessions", "to": "sessions" },
    { "from": "03_Synthesis", "to": "synthesis" },
    { "from": "04_Evaluation", "to": "evaluation" }
  ],
  "scaffold_dirs": ["glossary", "highlights", "codebook", ".compost", "..."]
}
```

## 2. Apply

```sh
compost migrate "/path/to/Seeds/Data Hub Foundational" --apply
```

Renames run atomically (rolled back on partial failure). Then it scaffolds the
missing compost dirs and `.compost/` (config.toml, AGENTS.md).

## Caveats

- **Numeric-prefix stripping is generic**: `NN_Name → name`. Unprefixed dirs
  (e.g. `_tools`) are left untouched.
- **Idempotent**: a second run reports `already_migrated`, `renames: 0`.
- **Refuses to clobber**: if a target like `plan/` already exists, migrate
  errors rather than merge — resolve by hand first.
- **An existing `seed.md` is preserved**; one is written from template only if
  absent.
- After migrating, the vector index builds automatically the first time you run
  `compost watch` (or `compost watch --once`). Note: `compost reindex --vectors`
  is **not wired yet** — it reports a `not_implemented` status and exits non-zero
  rather than rebuilding the index (#137). Use `compost watch` for the index.
