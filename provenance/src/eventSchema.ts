// Mirror of schema/events.schema.json. Single source of truth for runtime
// validation inside the provenance package. A future CI check will diff this
// against schema/events.schema.json and fail on drift.

export const EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://compost.dev/schema/event/1.0.json',
  title: 'Compost Provenance Event',
  type: 'object',
  required: [
    'id',
    'ts',
    'artifact_kind',
    'artifact_id',
    'action',
    'actor_type',
    'actor_id',
    'payload',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
    ts: { type: 'string', format: 'date-time' },
    artifact_kind: { type: 'string', minLength: 1 },
    artifact_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    action: { enum: ['create', 'update', 'endorse', 'reject', 'link', 'unlink'] },
    actor_type: { enum: ['researcher', 'agent', 'ai'] },
    actor_id: { type: 'string', minLength: 1 },
    agent_name: { type: 'string' },
    agent_version: { type: 'string' },
    prompt_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    model: { type: 'string' },
    input_id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    payload: { oneOf: [{ type: 'object' }, { type: 'array' }, { type: 'null' }] },
    parent_event: {
      type: ['string', 'null'],
      pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
    },
    batch_id: { type: ['string', 'null'], minLength: 1 },
  },
  allOf: [
    {
      if: {
        properties: { actor_type: { const: 'agent' } },
        required: ['actor_type'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else clause
      then: { required: ['agent_name', 'agent_version'] },
    },
    {
      if: {
        properties: { actor_type: { const: 'ai' } },
        required: ['actor_type'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else clause
      then: { required: ['model', 'prompt_hash'] },
    },
    {
      if: {
        properties: { action: { enum: ['endorse', 'reject', 'update', 'unlink'] } },
        required: ['action'],
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else clause
      then: { required: ['parent_event'] },
    },
  ],
} as const
