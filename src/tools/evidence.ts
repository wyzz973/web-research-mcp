/** Immutable paragraph evidence plans and continuation; no network access on read. */
import { randomUUID } from 'node:crypto'
import type { Evidence } from '../generated/websearch.output.ts'
import type { DocumentSnapshot, Passage, SnapshotStore } from '../shared/types.ts'
import { AppError } from '../shared/errors.ts'
import { ajv, getSchema } from '../shared/contracts.ts'
import { wireRelevance } from './common.ts'

interface EvidencePlan {
  version: 1
  snapshotId: string
  perPage: number
  maxChars: number
  evidence: Evidence[]
}

export interface EvidencePage {
  evidence: Evidence[]
  evidence_chars: number
  has_more_evidence: boolean
  next_evidence_cursor: string | null
}

function validateEvidence(snapshot: DocumentSnapshot, entries: readonly Evidence[]): void {
  const content = Array.from(snapshot.content)
  for (const entry of entries) {
    const segments = snapshot.segments
      .filter((s) => s.end_char > entry.start_char && s.start_char < entry.end_char)
      .map((s) => s.id)
    if (
      entry.snapshot_id !== snapshot.snapshotId ||
      entry.content_sha256 !== snapshot.contentSha256 ||
      entry.start_char < 0 ||
      entry.end_char <= entry.start_char ||
      entry.end_char > content.length ||
      content.slice(entry.start_char, entry.end_char).join('') !== entry.quote ||
      entry.segment_id !== segments[0] ||
      JSON.stringify(entry.segment_ids) !== JSON.stringify(segments) ||
      entry.url !== snapshot.finalUrl ||
      entry.expires_at !== snapshot.expiresAt
    ) {
      throw new AppError('STORAGE_UNAVAILABLE', 'Evidence no longer matches its retained snapshot.')
    }
  }
}

function takePage(plan: EvidencePlan, offset: number, maxChars: number) {
  const evidence: Evidence[] = []
  let count = 0
  for (const entry of plan.evidence.slice(offset, offset + plan.perPage)) {
    const length = Array.from(entry.quote).length
    const separator = evidence.length ? 2 : 0
    if (count + separator + length > maxChars) break
    count += separator + length
    evidence.push(entry)
  }
  if (!evidence.length)
    throw new AppError(
      'INVALID_ARGUMENT',
      'max_chars is too small for the next complete evidence paragraph. Increase it to read the paragraph without cutting its context.',
    )
  // Prioritization determines the page; its quotations are displayed in original document order.
  evidence.sort((a, b) => a.start_char - b.start_char)
  return {
    evidence,
    evidence_chars: evidence.reduce((sum, entry) => sum + Array.from(entry.quote).length, 0),
    nextOffset: offset + evidence.length,
  }
}

export function prepareEvidence(
  snapshot: DocumentSnapshot,
  passages: readonly Passage[],
  store: SnapshotStore,
  options: { perPage: number; maxChars: number },
): EvidencePage {
  if (!passages.length)
    return { evidence: [], evidence_chars: 0, has_more_evidence: false, next_evidence_cursor: null }
  const fullCursor = store.createCursor(
    'fetch',
    { snapshotId: snapshot.snapshotId, offset: 0 },
    snapshot.expiresAt,
  )
  const evidence: Evidence[] = passages.map((p) => ({
    id: `${snapshot.snapshotId}:${p.start_char}:${p.end_char}`,
    quote: p.quote,
    url: snapshot.finalUrl,
    snapshot_id: snapshot.snapshotId,
    snapshot_format: 'text',
    content_sha256: snapshot.contentSha256,
    segment_id: p.segment_id,
    segment_ids: [p.segment_ids[0] ?? p.segment_id, ...p.segment_ids.slice(1)],
    start_char: p.start_char,
    end_char: p.end_char,
    fetched_at: snapshot.fetchedAt,
    expires_at: snapshot.expiresAt,
    extractor_version: snapshot.extractorVersion,
    snapshot_cursor: fullCursor,
    verification: 'exact_match',
    selection_method: 'paragraph_context_v2',
    relevance: wireRelevance(p.relevance, 'quote'),
  }))
  validateEvidence(snapshot, evidence)
  const plan: EvidencePlan = {
    version: 1,
    snapshotId: snapshot.snapshotId,
    perPage: options.perPage,
    maxChars: options.maxChars,
    evidence,
  }
  const page = takePage(plan, 0, options.maxChars)
  const more = page.nextOffset < evidence.length
  let next: string | null = null
  if (more) {
    const planId = randomUUID()
    store.putEvidence(planId, plan, snapshot.expiresAt)
    next = store.createCursor(
      'fetch',
      { view: 'evidence', planId, offset: page.nextOffset },
      snapshot.expiresAt,
    )
  }
  return {
    evidence: page.evidence,
    evidence_chars: page.evidence_chars,
    has_more_evidence: more,
    next_evidence_cursor: next,
  }
}

function readPlan(value: unknown): EvidencePlan {
  const schema = getSchema('websearch.output')
  const validate = ajv.compile<EvidencePlan>({
    type: 'object',
    additionalProperties: false,
    required: ['version', 'snapshotId', 'perPage', 'maxChars', 'evidence'],
    properties: {
      version: { const: 1 },
      snapshotId: { type: 'string', minLength: 1 },
      perPage: { type: 'integer', minimum: 1, maximum: 5 },
      maxChars: { type: 'integer', minimum: 100, maximum: 8000 },
      evidence: { type: 'array', minItems: 1, maxItems: 64, items: { $ref: '#/$defs/evidence' } },
    },
    $defs: schema.$defs,
  })
  if (!validate(value)) throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored evidence plan.')
  return value
}

/** Resolve a fetch-kind evidence cursor to the same frozen candidate plan across restarts. */
export function readEvidencePage(
  payload: unknown,
  store: SnapshotStore,
  requestedMaxChars?: number,
): { snapshot: DocumentSnapshot; page: EvidencePage } {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('view' in payload) ||
    payload.view !== 'evidence' ||
    !('planId' in payload) ||
    typeof payload.planId !== 'string' ||
    !('offset' in payload) ||
    typeof payload.offset !== 'number' ||
    !Number.isSafeInteger(payload.offset) ||
    payload.offset < 0
  ) {
    throw new AppError('CURSOR_MISMATCH', 'Invalid evidence continuation cursor.')
  }
  const plan = readPlan(store.getEvidence(payload.planId))
  const snapshot = store.getDocument(plan.snapshotId)
  if (snapshot.format !== 'text' || payload.offset >= plan.evidence.length)
    throw new AppError(
      'CURSOR_MISMATCH',
      'Evidence cursor does not match this snapshot or position.',
    )
  validateEvidence(snapshot, plan.evidence)
  const page = takePage(
    plan,
    payload.offset,
    Math.min(requestedMaxChars ?? plan.maxChars, plan.maxChars),
  )
  const more = page.nextOffset < plan.evidence.length
  const next = more
    ? store.createCursor(
        'fetch',
        { view: 'evidence', planId: payload.planId, offset: page.nextOffset },
        snapshot.expiresAt,
      )
    : null
  return {
    snapshot,
    page: {
      evidence: page.evidence,
      evidence_chars: page.evidence_chars,
      has_more_evidence: more,
      next_evidence_cursor: next,
    },
  }
}
