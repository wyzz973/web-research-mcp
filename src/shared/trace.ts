import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export type TraceJson =
  null | boolean | number | string | TraceJson[] | { [key: string]: TraceJson }
export type TraceStatus =
  'running' | 'ok' | 'error' | 'partial' | 'cancelled' | 'skipped' | 'interrupted'
export interface TraceSpan {
  id: string
  parent_id: string | null
  name: string
  status: TraceStatus
  started_at: string
  ended_at?: string
  duration_ms?: number
  input: TraceJson
  output?: TraceJson
}
export interface TraceRun {
  id: string
  tool: string
  request_id?: string
  client_request_id?: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: TraceStatus
  owner_pid: number
  capture_content: boolean
  truncated: boolean
  input: TraceJson
  output?: TraceJson
  spans: TraceSpan[]
  span_count?: number
}
export interface TraceStore {
  put(run: TraceRun): void
  list(): TraceRun[]
  get(id: string): TraceRun | undefined
  close(): void
}
export interface TraceRunOptions {
  clientRequestId?: string
  captureContent?: boolean
}
export interface TraceRecorder {
  run<T>(tool: string, input: unknown, fn: () => Promise<T>, options?: TraceRunOptions): Promise<T>
  span<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    outputSummary?: (output: T) => unknown,
  ): Promise<T>
  event(name: string, status: TraceStatus, data?: unknown): void
  annotate(output: unknown, status?: TraceStatus): void
  currentTraceId(): string | undefined
}
export const TRACE_MAX_BYTES = 256 * 1024
const MAX_SPANS = 200
const MAX_PREVIEW = 2000
const SECRET =
  /authorization|cookie|password|passwd|secret|credential|api.?key|token|headers?|cursor/i
const SAFE_STRING =
  /^(status|code|error_code|name|tool|engine|engines|provider|method|format|mode|evidence_mode|ranking|strategy|reason|language|stage|phase|source|type|view|request_id|snapshot_id|source_id|content_sha256|contentSha256|checksum|sha256|content_type|extractor_version|extractorVersion|last_error|expires_at|fetched_at|retrieved_at|sites|include_domains|exclude_domains|hostname|domain|version)$/

/** Converts unknown telemetry to bounded plain JSON. Credentials never become recorded content. */
export function sanitizeTraceData(value: unknown, captureContent = false): TraceJson {
  const seen = new WeakSet<object>()
  let budget = MAX_PREVIEW
  let nodes = 0
  function visit(item: unknown, key: string, depth: number): TraceJson {
    if (SECRET.test(key)) return '[redacted]'
    if (
      !captureContent &&
      item !== null &&
      typeof item === 'object' &&
      /query|text|body|content|html|markdown|snippet|excerpt|quote|title|message|description/i.test(
        key,
      ) &&
      !SAFE_STRING.test(key)
    )
      return { redacted: true }
    nodes += 1
    budget -= 4
    if (nodes > 300) return '[truncated]'
    if (budget <= 0 || depth > 6) return '[truncated]'
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : '[non-finite]'
    if (typeof item === 'string') {
      if (/url|uri|origin/i.test(key) || /^https?:\/\//i.test(item)) {
        try {
          const url = new URL(item)
          if (!['http:', 'https:'].includes(url.protocol)) return '[redacted URL]'
          // Query, fragment and userinfo are excluded even when content capture is enabled.
          const text = captureContent ? `${url.origin}${url.pathname}` : url.origin
          budget -= text.length
          return text.slice(0, MAX_PREVIEW)
        } catch {
          return '[invalid URL]'
        }
      }
      if (
        (!captureContent && !SAFE_STRING.test(key)) ||
        /(?:Bearer\s|sk-[A-Za-z0-9]|password=|api_key=)/i.test(item)
      ) {
        return { redacted: true, chars: item.length }
      }
      const text = item.slice(0, Math.min(budget, MAX_PREVIEW))
      budget -= text.length
      return text.length < item.length ? `${text}…` : text
    }
    if (typeof item !== 'object') return '[non-JSON]'
    if (seen.has(item)) return '[circular]'
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return '[non-JSON object]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 30).map((entry) => visit(entry, key, depth + 1))
    const result: { [key: string]: TraceJson } = Object.create(null) as { [key: string]: TraceJson }
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item)).slice(
      0,
      24,
    )) {
      // Never invoke getters supplied by a caller while recording telemetry.
      budget -= name.length + 4
      if (budget <= 0) {
        result.truncated = true
        break
      }
      result[name.slice(0, 80)] =
        'value' in descriptor ? visit(descriptor.value, name, depth + 1) : '[accessor]'
    }
    return result
  }
  try {
    const result = visit(value, '', 0)
    const encoded = JSON.stringify(result)
    if (encoded.length <= MAX_PREVIEW) return result
    let preview = encoded.slice(0, 1800)
    while (JSON.stringify({ truncated: true, preview }).length > MAX_PREVIEW)
      preview = preview.slice(0, Math.floor(preview.length * 0.8))
    return { truncated: true, preview }
  } catch {
    return '[unrecordable]'
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const result: Record<string, unknown> = {}
    for (const key of ['status', 'code', 'error', 'isError', 'ok', 'request_id']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && 'value' in descriptor) result[key] = descriptor.value
    }
    return result
  } catch {
    return undefined
  }
}
function resultStatus(value: unknown): TraceStatus {
  const record = object(value)
  if (record?.status === 'partial') return 'partial'
  if (
    record?.status === 'cancelled' ||
    record?.code === 'CANCELLED' ||
    object(record?.error)?.code === 'CANCELLED'
  )
    return 'cancelled'
  if (record?.status === 'error' || record?.isError === true || record?.ok === false) return 'error'
  if (record?.status === 'skipped') return 'skipped'
  return 'ok'
}
function errorSummary(error: unknown): TraceJson {
  const code = object(error)?.code
  return { code: typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'INTERNAL_ERROR' }
}

/** Recording failures are intentionally isolated from business return values and exceptions. */
export function createTraceRecorder(options: {
  store: TraceStore
  captureContent?: boolean
  onError?: () => void
}): TraceRecorder {
  const context = new AsyncLocalStorage<{ run: TraceRun; span: TraceSpan | null }>()
  let reportedStorageFailure = false
  function persist(run: TraceRun): void {
    try {
      while (
        Buffer.byteLength(JSON.stringify(run), 'utf8') > TRACE_MAX_BYTES &&
        run.spans.length > 0
      ) {
        run.spans.pop()
        run.truncated = true
      }
      options.store.put(run)
    } catch {
      // Signal degraded observability once, without exposing exception text or interrupting work.
      if (!reportedStorageFailure) {
        reportedStorageFailure = true
        try {
          options.onError?.()
        } catch {
          /* A diagnostic callback cannot replace the business outcome. */
        }
      }
    }
  }
  function finish(target: TraceRun | TraceSpan, output: unknown, fallback: TraceStatus): void {
    const capture = context.getStore()?.run.capture_content ?? false
    if (target.status === 'running' || fallback === 'error' || fallback === 'cancelled')
      target.status = fallback
    target.ended_at = new Date().toISOString()
    target.duration_ms = Math.max(0, Date.parse(target.ended_at) - Date.parse(target.started_at))
    target.output = sanitizeTraceData(output, capture)
  }
  function startSpan(name: string, input: unknown): { run: TraceRun; span: TraceSpan } | undefined {
    const parent = context.getStore()
    if (!parent || parent.run.truncated || parent.run.ended_at !== undefined) return undefined
    if (parent.run.spans.length >= MAX_SPANS) {
      parent.run.truncated = true
      return undefined
    }
    const span: TraceSpan = {
      id: randomUUID(),
      parent_id: parent.span?.id ?? null,
      name: name.slice(0, 100),
      status: 'running',
      started_at: new Date().toISOString(),
      input: sanitizeTraceData(input, parent.run.capture_content),
    }
    parent.run.spans.push(span)
    persist(parent.run)
    return parent.run.spans.includes(span) ? { run: parent.run, span } : undefined
  }
  return {
    async run(tool, input, fn, runOptions) {
      const capture = runOptions?.captureContent ?? options.captureContent ?? false
      const run: TraceRun = {
        id: randomUUID(),
        tool: tool.slice(0, 100),
        started_at: new Date().toISOString(),
        status: 'running',
        owner_pid: process.pid,
        capture_content: capture,
        truncated: false,
        input: sanitizeTraceData(input, capture),
        spans: [],
      }
      if (runOptions?.clientRequestId && /^[a-f0-9-]{36}$/i.test(runOptions.clientRequestId))
        run.client_request_id = runOptions.clientRequestId
      persist(run)
      return context.run({ run, span: null }, async () => {
        try {
          const output = await fn()
          const id = object(output)?.request_id
          if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) run.request_id = id
          finish(run, run.output ?? output, resultStatus(output))
          return output
        } catch (error) {
          finish(
            run,
            errorSummary(error),
            object(error)?.code === 'CANCELLED' ? 'cancelled' : 'error',
          )
          throw error
        } finally {
          persist(run)
        }
      })
    },
    async span(name, input, fn, outputSummary) {
      const current = startSpan(name, input)
      if (!current) return fn()
      return context.run(current, async () => {
        try {
          const output = await fn()
          let summary: unknown = output
          try {
            if (outputSummary) summary = outputSummary(output)
          } catch {
            summary = { code: 'SUMMARY_UNAVAILABLE' }
          }
          finish(current.span, summary, resultStatus(output))
          return output
        } catch (error) {
          finish(
            current.span,
            errorSummary(error),
            object(error)?.code === 'CANCELLED' ? 'cancelled' : 'error',
          )
          throw error
        } finally {
          persist(current.run)
        }
      })
    },
    event(name, status, data = null) {
      const current = startSpan(name, null)
      if (!current) return
      finish(current.span, data, status)
      persist(current.run)
    },
    annotate(output, status) {
      const current = context.getStore()
      if (!current) return
      const target = current.span ?? current.run
      target.output = sanitizeTraceData(output, current.run.capture_content)
      if (status) target.status = status
      persist(current.run)
    },
    currentTraceId() {
      return context.getStore()?.run.id
    },
  }
}

export const noOpTraceRecorder: TraceRecorder = {
  run: (_tool, _input, fn) => fn(),
  span: (_name, _input, fn) => fn(),
  event() {},
  annotate() {},
  currentTraceId: () => undefined,
}
