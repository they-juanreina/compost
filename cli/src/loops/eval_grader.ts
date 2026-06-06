import {
  EvalStore,
  evalsDbPath,
  gradeSuggestions,
  type Judge,
  type Suggestion,
} from '@they-juanreina/compost-evals'

export interface EvalGraderDeps {
  judge: Judge
  judgeModel: string
  maxPerRun?: number
  now?: () => Date
}

export interface EvalGraderResult {
  graded: number
  skipped: number
}

/**
 * Grade a batch of AI-authored suggestions for a seed and persist verdicts to
 * .compost/evals.sqlite. Idempotent on suggestion_id (already-graded skipped)
 * and throttled to maxPerRun calls. The caller supplies the suggestions
 * (read from the provenance event log) and an LLM judge.
 */
export async function runEvalGraderOnce(
  seedPath: string,
  suggestions: Suggestion[],
  deps: EvalGraderDeps,
): Promise<EvalGraderResult> {
  const store = new EvalStore(evalsDbPath(seedPath))
  try {
    const { graded, skipped } = await gradeSuggestions(store, suggestions, deps.judge, {
      judgeModel: deps.judgeModel,
      ...(deps.maxPerRun !== undefined ? { maxPerRun: deps.maxPerRun } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    })
    return { graded: graded.length, skipped }
  } finally {
    store.close()
  }
}
