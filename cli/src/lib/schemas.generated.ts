/**
 * GENERATED — DO NOT EDIT. Run `pnpm --filter compost-cli run build` to regenerate.
 *
 * Embeds every schema/*.json file as a typed constant so validate.ts can use
 * them without filesystem IO. The CLI can be published standalone without
 * the schema/ tree because the schemas are now part of the compiled bundle.
 */

/* eslint-disable */
export const ANSWER_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://compost.dev/schema/answer/1.0.json",
  "title": "Compost Grounded Answer",
  "description": "A RAG answer whose every claim carries a citation. Used by the deterministic citation validator for non-Anthropic providers (#46).",
  "type": "object",
  "required": [
    "answer",
    "claims"
  ],
  "additionalProperties": false,
  "properties": {
    "answer": {
      "type": "string",
      "minLength": 1
    },
    "claims": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/claim"
      }
    },
    "insufficient_evidence": {
      "type": "boolean",
      "description": "True when retrieval came up short; answer should say so and claims may be empty."
    }
  },
  "$defs": {
    "claim": {
      "type": "object",
      "required": [
        "quote",
        "utterance_id",
        "session_id",
        "confidence"
      ],
      "additionalProperties": false,
      "properties": {
        "quote": {
          "type": "string",
          "minLength": 1
        },
        "utterance_id": {
          "type": "string",
          "pattern": "^U-[0-9]{4,}$"
        },
        "session_id": {
          "type": "string"
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    }
  }
}

export const CUES_TAXONOMY: Record<string, unknown> = {
  "version": "1.0",
  "title": "Compost Audio Cue Taxonomy",
  "description": "Canonical catalog of audio cue kinds. The transcript schema's cue.kind enum (schema/transcript.schema.json#/$defs/cue/properties/kind) is kept in sync with this list. Compost cues are audio-only by design — no pose or gesture classification.",
  "kinds": [
    {
      "kind": "laughter",
      "description": "Voiced laughter from a speaker — short bursts (\"ha\") or sustained chuckles. Detected by Whisper-AT / Calm-Whisper event-tag tokens.",
      "confidence_floor": 0.7,
      "source": "audio"
    },
    {
      "kind": "sigh",
      "description": "Audible voiced exhale, typically signaling resignation, relief, or thinking-out-loud. Detected by event-tag tokens.",
      "confidence_floor": 0.6,
      "source": "audio"
    },
    {
      "kind": "cough",
      "description": "Single or chained cough. High-energy short burst; distinctive spectral signature.",
      "confidence_floor": 0.75,
      "source": "audio"
    },
    {
      "kind": "throat-clear",
      "description": "Brief vocal-fry clear of the throat, often before a new utterance.",
      "confidence_floor": 0.65,
      "source": "audio"
    },
    {
      "kind": "unintelligible",
      "description": "Speech the ASR could not transcribe with acceptable confidence. Boundary inherited from the failed Whisper segment.",
      "confidence_floor": 0.5,
      "source": "audio"
    },
    {
      "kind": "code-switching",
      "description": "Speaker switched languages mid-utterance. Whisper-large-v3 emits language tokens that mark the transition.",
      "confidence_floor": 0.7,
      "source": "audio"
    },
    {
      "kind": "overlap",
      "description": "Two or more speakers vocalizing simultaneously. Detected by pyannote-audio overlap detection.",
      "confidence_floor": 0.7,
      "source": "audio"
    },
    {
      "kind": "interruption",
      "description": "Turn-stealing overlap where speaker B begins while speaker A is still speaking and A yields. Heuristic over overlap + turn-change.",
      "confidence_floor": 0.65,
      "source": "audio"
    }
  ]
}

export const EVENTS_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://compost.dev/schema/event/1.0.json",
  "title": "Compost Provenance Event",
  "description": "Append-only event recording a change to a compost artifact. Mirrors the .compost/events.sqlite row shape. Three-actor model: researcher | agent | ai.",
  "type": "object",
  "required": [
    "id",
    "ts",
    "artifact_kind",
    "artifact_id",
    "action",
    "actor_type",
    "actor_id",
    "payload"
  ],
  "additionalProperties": false,
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$",
      "description": "ULID (Crockford base32, 26 chars). Sortable and globally unique."
    },
    "ts": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 UTC timestamp the event was recorded."
    },
    "artifact_kind": {
      "type": "string",
      "minLength": 1,
      "description": "Kind of artifact this event affects: highlight, code, theme, term, insight, comment, frame, frame_annotation, utterance_annotation, code_theme_link, term_utterance_link, etc. Free-form string to allow extension without schema migration."
    },
    "artifact_id": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$",
      "description": "SHA256 of the artifact's initial state. Stable across the artifact's lifetime."
    },
    "action": {
      "enum": [
        "create",
        "update",
        "endorse",
        "reject",
        "link",
        "unlink"
      ],
      "description": "Lifecycle action. AI-authored artifacts surface as un-endorsed (human_approved=false) until an `endorse` event from a researcher promotes them."
    },
    "actor_type": {
      "enum": [
        "researcher",
        "agent",
        "ai"
      ],
      "description": "researcher = human, accountable. agent = deterministic-ish software actor (skill, loop, slash command). ai = raw LLM output, untrusted by default."
    },
    "actor_id": {
      "type": "string",
      "minLength": 1,
      "description": "For researchers: handle or email. For agents: name@semver. For ai: model identifier (e.g. anthropic:claude-opus-4-7)."
    },
    "agent_name": {
      "type": "string",
      "description": "Required when actor_type=agent. Identifies the software actor (e.g. cross-session-similarity-scanner)."
    },
    "agent_version": {
      "type": "string",
      "description": "Required when actor_type=agent. Semver."
    },
    "prompt_hash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$",
      "description": "Required when actor_type=ai or actor_type=agent and the agent invoked an LLM. SHA256(prompt + model + temperature + context_window)."
    },
    "model": {
      "type": "string",
      "description": "Required when actor_type=ai. The model that produced the suggestion (e.g. anthropic:claude-opus-4-7, ollama:llama3.1:8b)."
    },
    "payload": {
      "description": "Action-specific JSON payload. The structure varies by (artifact_kind, action) pair and is validated separately by the CLI when serializing/deserializing.",
      "oneOf": [
        {
          "type": "object"
        },
        {
          "type": "array"
        },
        {
          "type": "null"
        }
      ]
    },
    "parent_event": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$",
      "description": "ULID of the event this one continues from. null for root events. Endorse/reject/update/unlink events MUST reference the event being acted on; link events may have null parent_event for the first link of a relationship."
    },
    "batch_id": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "description": "Optional opaque grouping for events emitted by one loop run, for transactional rollback and audit."
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "actor_type": {
            "const": "agent"
          }
        },
        "required": [
          "actor_type"
        ]
      },
      "then": {
        "required": [
          "agent_name",
          "agent_version"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "actor_type": {
            "const": "ai"
          }
        },
        "required": [
          "actor_type"
        ]
      },
      "then": {
        "required": [
          "model",
          "prompt_hash"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "action": {
            "enum": [
              "endorse",
              "reject",
              "update",
              "unlink"
            ]
          }
        },
        "required": [
          "action"
        ]
      },
      "then": {
        "required": [
          "parent_event"
        ]
      }
    }
  ]
}

export const FRAMES_TAXONOMY: Record<string, unknown> = {
  "version": "1.0",
  "title": "Compost Frame Trigger Catalog",
  "description": "Canonical catalog of frame triggers — the reasons a screenshot may be captured from the video stream during transcription. The transcript schema's frame.trigger enum (schema/transcript.schema.json#/$defs/frame/properties/trigger) is kept in sync with this list. default_enabled reflects the 'balanced' default profile (decision #73).",
  "triggers": [
    {
      "trigger": "silence_after_question",
      "description": "Frame captured during a silence the silence-typer classified as after_question. Pauses after moderator questions are high-signal.",
      "default_enabled": true
    },
    {
      "trigger": "silence_mid_utterance",
      "description": "Frame captured during a mid-utterance silence — speaker paused inside their own turn, often searching for a word.",
      "default_enabled": true
    },
    {
      "trigger": "silence_thinking",
      "description": "Frame captured during a thinking silence — speaker hasn't committed to answering yet.",
      "default_enabled": true
    },
    {
      "trigger": "silence_interruption",
      "description": "Frame captured at a silence inside an interruption — turn-stealing dynamics often visible.",
      "default_enabled": true
    },
    {
      "trigger": "audio_cue",
      "description": "Frame captured when an audio cue fires (laughter, sigh, cough, throat-clear). Linked to the cue id.",
      "default_enabled": true
    },
    {
      "trigger": "shot_change",
      "description": "Frame captured when the perceptual-hash distance between consecutive sampled frames crosses the shot-change threshold. Catches camera/screen-share switches.",
      "default_enabled": true
    },
    {
      "trigger": "highlight",
      "description": "Frame captured at the moment a researcher creates a highlight. The contemporaneous frame is auto-linked to the highlight.",
      "default_enabled": true
    },
    {
      "trigger": "manual",
      "description": "Frame captured on explicit researcher request via `compost snap` or a one-click control in the web player.",
      "default_enabled": true
    },
    {
      "trigger": "sampling",
      "description": "Fallback frame captured at fixed intervals (60s default) when none of the other triggers have fired recently. Ensures every minute of every session has at least one frame.",
      "default_enabled": true
    }
  ]
}

export const STATUS_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://compost.dev/schema/status/1.0.json",
  "title": "Compost Status Snapshot",
  "description": "Structured snapshot of every seed in the working tree. Stable contract for agents calling `compost status --json`.",
  "type": "object",
  "required": [
    "schema_version",
    "generated_at",
    "root",
    "seeds"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "generated_at": {
      "type": "string",
      "format": "date-time"
    },
    "root": {
      "type": "string",
      "description": "Absolute path of the Seeds/ root that was scanned."
    },
    "seeds": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/seed"
      }
    }
  },
  "$defs": {
    "seed": {
      "type": "object",
      "required": [
        "name",
        "path",
        "counts"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "status": {
          "type": [
            "string",
            "null"
          ],
          "description": "From seed.md frontmatter. Common values: planning | active | synthesis | done."
        },
        "owners": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "created_at": {
          "type": [
            "string",
            "null"
          ]
        },
        "counts": {
          "$ref": "#/$defs/counts"
        }
      }
    },
    "counts": {
      "type": "object",
      "required": [
        "sessions",
        "highlights",
        "codes",
        "themes",
        "frames",
        "insights",
        "legacy_assets"
      ],
      "additionalProperties": false,
      "properties": {
        "sessions": {
          "$ref": "#/$defs/sessionCounts"
        },
        "highlights": {
          "type": "integer",
          "minimum": 0
        },
        "codes": {
          "type": "integer",
          "minimum": 0
        },
        "themes": {
          "type": "integer",
          "minimum": 0
        },
        "frames": {
          "type": "integer",
          "minimum": 0
        },
        "insights": {
          "type": "integer",
          "minimum": 0
        },
        "legacy_assets": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "sessionCounts": {
      "type": "object",
      "required": [
        "total",
        "transcribed",
        "queued",
        "inbox"
      ],
      "additionalProperties": false,
      "properties": {
        "total": {
          "type": "integer",
          "minimum": 0
        },
        "transcribed": {
          "type": "integer",
          "minimum": 0
        },
        "queued": {
          "type": "integer",
          "minimum": 0
        },
        "inbox": {
          "type": "integer",
          "minimum": 0
        }
      }
    }
  }
}

export const TRANSCRIPT_SCHEMA: Record<string, unknown> = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://compost.dev/schema/transcript/1.0.json",
  "title": "Compost Rich Transcript",
  "description": "Per-session rich transcript with utterances, typed silences, audio cues, frames, prosody hints, and provenance pointer.",
  "type": "object",
  "required": [
    "schema_version",
    "session_id",
    "source",
    "language",
    "duration_ms",
    "modality",
    "speakers",
    "utterances",
    "provenance"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": {
      "const": "1.0",
      "description": "Locked at 1.0 for this contract. Breaking changes bump the major."
    },
    "kind": {
      "enum": [
        "session",
        "document"
      ],
      "default": "session",
      "description": "session = recorded interview; document = legacy PDF/DOCX/PPTX/CSV normalized into a transcript-shaped doc."
    },
    "session_id": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-]+$",
      "description": "Stable, filesystem-safe session identifier (e.g. \"S023\")."
    },
    "source": {
      "type": "string",
      "description": "Path to the source media file, relative to the seed root."
    },
    "language": {
      "type": "string",
      "description": "BCP-47 language tag (e.g. \"es-CO\", \"en-US\")."
    },
    "duration_ms": {
      "type": "integer",
      "minimum": 0
    },
    "modality": {
      "type": "array",
      "items": {
        "enum": [
          "audio",
          "video",
          "document"
        ]
      },
      "minItems": 1,
      "uniqueItems": true
    },
    "speakers": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/speaker"
      }
    },
    "utterances": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/utterance"
      }
    },
    "silences": {
      "type": "array",
      "default": [],
      "items": {
        "$ref": "#/$defs/silence"
      }
    },
    "cues": {
      "type": "array",
      "default": [],
      "items": {
        "$ref": "#/$defs/cue"
      }
    },
    "frames": {
      "type": "array",
      "default": [],
      "items": {
        "$ref": "#/$defs/frame"
      }
    },
    "glossary_refs": {
      "type": "array",
      "default": [],
      "items": {
        "$ref": "#/$defs/sessionGlossaryRef"
      },
      "description": "Optional session-level rollup of glossary term mentions; derivable from utterances[].glossary_refs."
    },
    "provenance": {
      "$ref": "#/$defs/provenance"
    }
  },
  "$defs": {
    "speaker": {
      "type": "object",
      "required": [
        "id",
        "type"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^S[0-9]+$",
          "description": "Speaker handle, e.g. \"S1\", \"S2\"."
        },
        "name": {
          "type": "string"
        },
        "type": {
          "enum": [
            "moderator",
            "participant",
            "other"
          ]
        }
      }
    },
    "utterance": {
      "type": "object",
      "required": [
        "id",
        "speaker_id",
        "turn",
        "start_ms",
        "end_ms",
        "text"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^U-[0-9]{4,}$",
          "description": "Zero-padded ordinal, e.g. \"U-0001\"."
        },
        "speaker_id": {
          "type": "string",
          "pattern": "^S[0-9]+$"
        },
        "turn": {
          "type": "integer",
          "minimum": 1
        },
        "start_ms": {
          "type": "integer",
          "minimum": 0
        },
        "end_ms": {
          "type": "integer",
          "minimum": 0
        },
        "text": {
          "type": "string"
        },
        "source_page": {
          "type": "integer",
          "minimum": 1,
          "description": "For document-kind transcripts: the 1-based source page/slide/row the utterance came from."
        },
        "words": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/word"
          }
        },
        "prosody": {
          "$ref": "#/$defs/prosody"
        },
        "annotation": {
          "type": "string",
          "description": "Free-text editorial layer. May be human-authored, agent-authored, or AI-suggested. Provenance lives in .compost/events.sqlite — this field is a snapshot of current text only."
        },
        "glossary_refs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/utteranceGlossaryRef"
          }
        }
      }
    },
    "word": {
      "type": "object",
      "required": [
        "w",
        "s",
        "e"
      ],
      "additionalProperties": false,
      "properties": {
        "w": {
          "type": "string"
        },
        "s": {
          "type": "integer",
          "minimum": 0
        },
        "e": {
          "type": "integer",
          "minimum": 0
        },
        "conf": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        }
      }
    },
    "prosody": {
      "type": "object",
      "additionalProperties": false,
      "description": "Deterministic prosody hints derived from word confidence + VAD energy + speech rate. Not ML predictions.",
      "properties": {
        "volume": {
          "enum": [
            "low",
            "normal",
            "high"
          ]
        },
        "pace": {
          "enum": [
            "slow",
            "normal",
            "fast"
          ]
        },
        "hesitations": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "silence": {
      "type": "object",
      "required": [
        "id",
        "start_ms",
        "end_ms",
        "duration_ms",
        "context"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^SIL-[0-9]{3,}$"
        },
        "start_ms": {
          "type": "integer",
          "minimum": 0
        },
        "end_ms": {
          "type": "integer",
          "minimum": 0
        },
        "duration_ms": {
          "type": "integer",
          "minimum": 0
        },
        "context": {
          "enum": [
            "after_question",
            "mid_utterance",
            "thinking",
            "interruption"
          ],
          "description": "Semantic typing from the silence-typer heuristic. Versioned rules; researcher can override."
        },
        "annotation": {
          "type": "string"
        }
      }
    },
    "cue": {
      "type": "object",
      "required": [
        "id",
        "kind",
        "start_ms",
        "end_ms",
        "source"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^CUE-[0-9]{3,}$"
        },
        "kind": {
          "enum": [
            "laughter",
            "sigh",
            "cough",
            "throat-clear",
            "unintelligible",
            "code-switching",
            "overlap",
            "interruption"
          ],
          "description": "See cues.taxonomy.json for confidence floors per kind."
        },
        "start_ms": {
          "type": "integer",
          "minimum": 0
        },
        "end_ms": {
          "type": "integer",
          "minimum": 0
        },
        "source": {
          "const": "audio",
          "description": "Compost cues are audio-only by design. No pose/gesture classification."
        },
        "speaker_id": {
          "type": "string",
          "pattern": "^S[0-9]+$"
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "annotation": {
          "type": "string"
        }
      }
    },
    "frame": {
      "type": "object",
      "required": [
        "id",
        "at_ms",
        "path",
        "trigger"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^FR-[0-9]{3,}$"
        },
        "at_ms": {
          "type": "integer",
          "minimum": 0
        },
        "path": {
          "type": "string",
          "description": "Path to the captured frame, relative to the seed root."
        },
        "trigger": {
          "enum": [
            "silence_after_question",
            "silence_mid_utterance",
            "silence_thinking",
            "silence_interruption",
            "audio_cue",
            "shot_change",
            "highlight",
            "manual",
            "sampling"
          ],
          "description": "See frames.taxonomy.json for trigger semantics. Silence triggers are split by silence context so a frame can carry the same semantic type as its linked silence."
        },
        "linked_utterance_id": {
          "type": "string",
          "pattern": "^U-[0-9]{4,}$"
        },
        "annotation": {
          "type": "string",
          "description": "Optional one-sentence description from a vision-capable LLM. AI-authored events surface as [draft] until endorsed."
        }
      }
    },
    "utteranceGlossaryRef": {
      "type": "object",
      "required": [
        "term_id",
        "span"
      ],
      "additionalProperties": false,
      "properties": {
        "term_id": {
          "type": "string",
          "pattern": "^T-[A-Za-z0-9_-]+$"
        },
        "span": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 0
          },
          "minItems": 2,
          "maxItems": 2,
          "description": "[start, end] character offsets into the parent utterance.text."
        }
      }
    },
    "sessionGlossaryRef": {
      "type": "object",
      "required": [
        "term_id",
        "utterance_id",
        "span"
      ],
      "additionalProperties": false,
      "properties": {
        "term_id": {
          "type": "string",
          "pattern": "^T-[A-Za-z0-9_-]+$"
        },
        "utterance_id": {
          "type": "string",
          "pattern": "^U-[0-9]{4,}$"
        },
        "span": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 0
          },
          "minItems": 2,
          "maxItems": 2
        }
      }
    },
    "provenance": {
      "type": "object",
      "required": [
        "transcriber"
      ],
      "additionalProperties": false,
      "description": "Tool+version pointers describing how this transcript was produced. Per-artifact event provenance lives in .compost/events.sqlite.",
      "properties": {
        "transcriber": {
          "type": "string",
          "description": "Tool@version that produced this transcript (e.g. \"compost-transcriber@0.3.1\")."
        },
        "asr_model": {
          "type": "string"
        },
        "diarizer": {
          "type": "string"
        },
        "audio_cues": {
          "type": "string"
        },
        "frame_capture": {
          "type": "string"
        },
        "frame_annotation": {
          "type": "string"
        },
        "text_col_resolved": {
          "type": "string",
          "description": "For CSV/XLSX legacy ingest: which column was actually used as the text source (auto-detected or explicit). Optional; absent on audio/video transcripts."
        },
        "xlsx_rows_skipped_empty_text": {
          "type": "integer",
          "minimum": 0,
          "description": "For XLSX legacy ingest: count of rows where other columns had data but the text column was empty. Often signals un-evaluated formulas — open the file in Excel once or export to CSV. Absent when zero."
        }
      }
    }
  }
}

export const ALL_SCHEMAS: Record<string, Record<string, unknown>> = {
  "answer.schema.json": ANSWER_SCHEMA,
  "cues.taxonomy.json": CUES_TAXONOMY,
  "events.schema.json": EVENTS_SCHEMA,
  "frames.taxonomy.json": FRAMES_TAXONOMY,
  "status.schema.json": STATUS_SCHEMA,
  "transcript.schema.json": TRANSCRIPT_SCHEMA,
}
