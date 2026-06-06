-- Content-addressed generation inputs → reproducible AI/agent provenance.
-- An events row references one ai_inputs row via input_id (nullable: researcher
-- events carry none). Lets `compost rerun` regenerate a suggestion and a PROV-O
-- export list an AI Activity's real inputs, instead of only a one-way prompt_hash.
CREATE TABLE ai_inputs (
  input_id      TEXT PRIMARY KEY,   -- sha256 of the canonical input bundle
  model         TEXT NOT NULL,
  params        TEXT,               -- JSON: {temperature, top_p, max_tokens, seed}
  system_prompt TEXT,
  prompt        TEXT NOT NULL,      -- rendered messages (JSON) or a canonical
                                    -- description of a deterministic operation
  context       TEXT,               -- JSON: retrieved evidence, glossary, params
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE events ADD COLUMN input_id TEXT REFERENCES ai_inputs(input_id);
CREATE INDEX idx_events_input ON events(input_id);
