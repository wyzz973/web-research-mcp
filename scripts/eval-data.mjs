import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)
const querySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'query', 'language', 'category', 'sites'],
  properties: {
    id: { type: 'string', pattern: '^q[0-9]{3}$' },
    query: { type: 'string', minLength: 1, maxLength: 2000 },
    language: { enum: ['en', 'zh'] },
    category: {
      enum: ['exact', 'concept', 'error', 'version', 'freshness', 'comparison', 'short', 'sites'],
    },
    sites: {
      type: 'array',
      maxItems: 10,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
  },
}
export const validateCatalog = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'created_at', 'purpose', 'queries'],
  properties: {
    version: { const: 1 },
    created_at: { type: 'string', format: 'date' },
    purpose: { type: 'string' },
    queries: { type: 'array', minItems: 1, maxItems: 200, items: querySchema },
  },
})
const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'url', 'title', 'snippet', 'original_rank'],
  properties: {
    id: { type: 'string', minLength: 1 },
    url: { type: 'string', pattern: '^https?://', format: 'uri' },
    title: { type: 'string', maxLength: 12000 },
    snippet: { type: 'string', maxLength: 12000 },
    original_rank: { type: 'integer', minimum: 1, maximum: 200 },
  },
}
export const validatePool = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'kind',
    'query',
    'captured_at',
    'node',
    'status',
    'elapsed_ms',
    'response_sha256',
    'candidates',
    'evidence',
  ],
  properties: {
    version: { const: 1 },
    kind: { const: 'live_mcp' },
    query: querySchema,
    captured_at: { type: 'string', format: 'date-time' },
    node: { type: 'string' },
    status: { enum: ['ok', 'partial', 'empty', 'error', 'transport_error', 'unknown'] },
    elapsed_ms: { type: 'number', minimum: 0 },
    response_sha256: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
    error_code: { type: ['string', 'null'] },
    candidates: { type: 'array', maxItems: 200, items: candidateSchema },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['target_results', 'verified_results'],
      properties: {
        target_results: { type: 'integer', minimum: 0 },
        verified_results: { type: 'integer', minimum: 0 },
      },
    },
  },
})
export const validateJudgments = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'query_id', 'pool_sha256', 'assessor', 'judged_at', 'basis', 'judgments'],
  properties: {
    version: { const: 1 },
    query_id: { type: 'string' },
    pool_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    assessor: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: { kind: { enum: ['human', 'agent'] }, id: { type: 'string', minLength: 1 } },
    },
    judged_at: { type: 'string', format: 'date-time' },
    basis: { enum: ['title_snippet', 'fetched_document'] },
    judgments: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'grade', 'reason'],
        properties: {
          id: { type: 'string' },
          grade: { enum: [0, 1, 2] },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
})
export function assertValid(validate, value) {
  if (!validate(value)) throw new Error(ajv.errorsText(validate.errors))
  if (validate === validatePool) {
    const candidates = value.candidates
    if (
      new Set(candidates.map((item) => item.id)).size !== candidates.length ||
      candidates.some((item, index) => item.original_rank !== index + 1) ||
      (['empty', 'error', 'transport_error'].includes(value.status) && candidates.length !== 0) ||
      value.evidence.verified_results > value.evidence.target_results ||
      value.evidence.target_results > candidates.length
    )
      throw new Error('Invalid candidate identity, ordering, status or evidence counts.')
  }
  return value
}
export function poolHash(pool) {
  return createHash('sha256').update(JSON.stringify(pool)).digest('hex')
}
export async function readBoundedJson(file, maxBytes = 4 * 1024 * 1024) {
  const info = await stat(file)
  if (!info.isFile() || info.size > maxBytes)
    throw new Error(`Evaluation file exceeds budget or is not a file: ${file}`)
  const bytes = await readFile(file)
  if (bytes.length > maxBytes) throw new Error(`Evaluation file exceeds ${maxBytes} bytes: ${file}`)
  return JSON.parse(bytes.toString('utf8'))
}
