import { Ajv2020 } from 'ajv/dist/2020.js'

import { ANSWER_SCHEMA } from './answerSchema.js'

export interface Claim {
  quote: string
  utterance_id: string
  session_id: string
  confidence: number
}

export interface Answer {
  answer: string
  claims: Claim[]
  insufficient_evidence?: boolean
}

/** The retrieval set the answer must be grounded in: utterance_id → its text. */
export type EvidenceSet = Map<string, { session_id: string; text: string }>

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
const validateSchema = ajv.compile(ANSWER_SCHEMA)

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Validate an answer: schema-valid, every claim's utterance_id in the
 * evidence set, and every quote substring-matches that utterance's text. */
export function validateAnswer(answer: unknown, evidence: EvidenceSet): ValidationResult {
  const errors: string[] = []
  if (!validateSchema(answer)) {
    return {
      ok: false,
      errors: (validateSchema.errors ?? []).map((e) => `schema: ${e.instancePath} ${e.message}`),
    }
  }
  const a = answer as Answer
  if (a.insufficient_evidence === true) return { ok: true, errors: [] }

  for (const claim of a.claims) {
    const ev = evidence.get(claim.utterance_id)
    if (ev === undefined) {
      errors.push(`citation ${claim.utterance_id} is not in the retrieval set`)
      continue
    }
    if (ev.session_id !== claim.session_id) {
      errors.push(
        `citation ${claim.utterance_id} session mismatch (${claim.session_id} ≠ ${ev.session_id})`,
      )
    }
    if (!normalize(ev.text).includes(normalize(claim.quote))) {
      errors.push(`quote for ${claim.utterance_id} does not substring-match the source utterance`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export interface RetryDeps {
  /** Calls the model with a correction prompt; returns parsed JSON or throws. */
  regenerate: (correction: string) => Promise<unknown>
  maxRetries?: number
}

export const INSUFFICIENT_EVIDENCE: Answer = {
  answer: 'Insufficient evidence in the retrieved material to answer this confidently.',
  claims: [],
  insufficient_evidence: true,
}

/**
 * Validate; on failure, re-prompt the model with the validation diff up to
 * maxRetries (default 3). After that, return the insufficient-evidence answer
 * rather than unverified content.
 */
export async function validateWithRetry(
  initial: unknown,
  evidence: EvidenceSet,
  deps: RetryDeps,
): Promise<{ answer: Answer; attempts: number; gaveUp: boolean }> {
  const max = deps.maxRetries ?? 3
  let candidate = initial
  for (let attempt = 0; attempt <= max; attempt++) {
    const result = validateAnswer(candidate, evidence)
    if (result.ok) return { answer: candidate as Answer, attempts: attempt, gaveUp: false }
    if (attempt === max) break
    candidate = await deps.regenerate(
      `Your previous answer failed citation validation:\n- ${result.errors.join('\n- ')}\nReturn corrected JSON; every claim must quote verbatim from the cited utterance.`,
    )
  }
  return { answer: INSUFFICIENT_EVIDENCE, attempts: max, gaveUp: true }
}
