// Runtime mirror of schema/answer.schema.json for the validator. A CI sync
// check against the canonical JSON file is a follow-up.

export const ANSWER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://compost.dev/schema/answer/1.0.json',
  type: 'object',
  required: ['answer', 'claims'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string', minLength: 1 },
    claims: { type: 'array', items: { $ref: '#/$defs/claim' } },
    insufficient_evidence: { type: 'boolean' },
  },
  $defs: {
    claim: {
      type: 'object',
      required: ['quote', 'utterance_id', 'session_id', 'confidence'],
      additionalProperties: false,
      properties: {
        quote: { type: 'string', minLength: 1 },
        utterance_id: { type: 'string', pattern: '^U-[0-9]{4,}$' },
        session_id: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  },
} as const
