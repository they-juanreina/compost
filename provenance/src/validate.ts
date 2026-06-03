import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsImport from 'ajv-formats'

import { ProvenanceError } from './errors.js'
import { EVENT_SCHEMA } from './eventSchema.js'
import type { Event } from './types.js'

// ajv-formats ships as a CJS module with a `default` export; under NodeNext ESM
// the runtime sees the namespace and the callable lives on `.default`.
type AddFormatsFn = (ajv: Ajv2020) => Ajv2020
const addFormats =
  (addFormatsImport as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsImport as unknown as AddFormatsFn)

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
const compiled = ajv.compile(EVENT_SCHEMA)

export function validateEvent(event: unknown): asserts event is Event {
  if (!compiled(event)) {
    throw new ProvenanceError('SCHEMA_VIOLATION', 'Event failed schema validation', {
      details: compiled.errors,
    })
  }
}
