-- Append-only provenance event log. See ROADMAP § Provenance & the three-actor model.
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  agent_name    TEXT,
  agent_version TEXT,
  prompt_hash   TEXT,
  model         TEXT,
  payload       TEXT NOT NULL,
  parent_event  TEXT REFERENCES events(id),
  batch_id      TEXT
);

CREATE INDEX idx_events_artifact ON events(artifact_kind, artifact_id);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_batch ON events(batch_id);
CREATE INDEX idx_events_parent ON events(parent_event);
