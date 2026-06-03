import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'

export interface Verdict {
  suggestion_id: string
  verdict: 'pass' | 'fail'
  score: number
  explanation: string
  rubric_version: string
  rubric_sha: string
  judge_model: string
  judge_prompt_hash: string
  graded_at: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verdicts (
  suggestion_id     TEXT PRIMARY KEY,
  verdict           TEXT NOT NULL,
  score             REAL NOT NULL,
  explanation       TEXT NOT NULL,
  rubric_version    TEXT NOT NULL,
  rubric_sha        TEXT NOT NULL,
  judge_model       TEXT NOT NULL,
  judge_prompt_hash TEXT NOT NULL,
  graded_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdicts_score ON verdicts(score);
`

export class EvalStore {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  /** Idempotent on suggestion_id: re-grading overwrites the prior verdict. */
  put(v: Verdict): void {
    this.db
      .prepare(
        `INSERT INTO verdicts (suggestion_id, verdict, score, explanation, rubric_version,
           rubric_sha, judge_model, judge_prompt_hash, graded_at)
         VALUES (@suggestion_id, @verdict, @score, @explanation, @rubric_version,
           @rubric_sha, @judge_model, @judge_prompt_hash, @graded_at)
         ON CONFLICT(suggestion_id) DO UPDATE SET
           verdict=excluded.verdict, score=excluded.score, explanation=excluded.explanation,
           rubric_version=excluded.rubric_version, rubric_sha=excluded.rubric_sha,
           judge_model=excluded.judge_model, judge_prompt_hash=excluded.judge_prompt_hash,
           graded_at=excluded.graded_at`,
      )
      .run(v)
  }

  get(suggestionId: string): Verdict | null {
    const row = this.db.prepare('SELECT * FROM verdicts WHERE suggestion_id = ?').get(suggestionId)
    return (row as Verdict | undefined) ?? null
  }

  has(suggestionId: string): boolean {
    return this.get(suggestionId) !== null
  }

  /** Suggestions below the export floor — blocked from exports until endorsed. */
  belowFloor(floor: number): Verdict[] {
    return this.db
      .prepare('SELECT * FROM verdicts WHERE score < ? ORDER BY score')
      .all(floor) as Verdict[]
  }

  close(): void {
    this.db.close()
  }
}

export function evalsDbPath(seedPath: string): string {
  return join(seedPath, '.compost', 'evals.sqlite')
}
