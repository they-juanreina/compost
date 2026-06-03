-- Materialized current-state-from-events snapshots. See ROADMAP § Provenance.
-- One row per (artifact_kind, artifact_id). Rebuildable from `events` at any time.
CREATE TABLE snapshots (
  artifact_kind   TEXT NOT NULL,
  artifact_id     TEXT NOT NULL,
  current_state   TEXT NOT NULL,
  version         INTEGER NOT NULL,
  last_event      TEXT NOT NULL REFERENCES events(id),
  human_approved  INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artifact_kind, artifact_id)
);

CREATE INDEX idx_snapshots_archived ON snapshots(archived);
CREATE INDEX idx_snapshots_approved ON snapshots(human_approved);
CREATE INDEX idx_snapshots_last_event ON snapshots(last_event);
