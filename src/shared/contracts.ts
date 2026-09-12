/** Author-owned JSON Schema validation at wire and durable JSON boundaries. */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import { AppError } from './errors.ts'

export const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)

const schemas = new Map<string, Record<string, unknown>>()

/** Read a schema relative to either the source or the built module. */
export function getSchema(name: string): Record<string, unknown> {
  const cached = schemas.get(name)
  if (cached) return cached
  const value: unknown = JSON.parse(
    readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'),
  )
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid schema ${name}`)
  const schema = value as Record<string, unknown>
  schemas.set(name, schema)
  return schema
}

/** Validate external JSON before assigning its generated wire type. */
export function parseContract<T>(name: string, value: unknown): T {
  const validate = ajv.compile<T>(getSchema(name))
  if (!validate(value))
    throw new AppError('INVALID_ARGUMENT', validationMessage(name, value, validate.errors))
  return value
}

/** Explain known cross-field constraints without weakening their schema validation. */
export function validationMessage(
  name: unknown,
  value: unknown,
  errors: ErrorObject[] | null | undefined,
): string {
  if (
    name === 'websearch.input' &&
    value &&
    typeof value === 'object' &&
    'sites' in value &&
    'include_domains' in value
  ) {
    return 'Provide sites or include_domains, not both.'
  }
  if (
    name === 'webfetch.input' &&
    value &&
    typeof value === 'object' &&
    'cursor' in value &&
    'engine' in value
  )
    return 'Do not supply engine with cursor; the saved snapshot already fixes the fetch backend.'
  if (
    name === 'websearch.input' &&
    value &&
    typeof value === 'object' &&
    'fetch_engine' in value &&
    (!('evidence_mode' in value) || value.evidence_mode !== 'extract')
  )
    return 'fetch_engine requires evidence_mode=extract.'
  return ajv.errorsText(errors)
}
