// JSON Schema passed to providers that support structured output, so the
// model returns a citation-carrying answer the retrieval validator can check.
// Mirrors schema/answer.schema.json.
export const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['answer', 'claims'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    insufficient_evidence: { type: 'boolean' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['quote', 'utterance_id', 'session_id', 'confidence'],
        additionalProperties: false,
        properties: {
          quote: { type: 'string' },
          utterance_id: { type: 'string' },
          session_id: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
}
