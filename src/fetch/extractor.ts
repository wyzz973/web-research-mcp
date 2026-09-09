import { Worker } from 'node:worker_threads'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import type { SourceMetadata } from '../generated/source-metadata.ts'
import { ajv, getSchema } from '../shared/contracts.ts'

const validMetadata = ajv.compile<SourceMetadata>(getSchema('source-metadata'))

export interface Extracted {
  title: string
  text: string
  markdown: string
  warnings: string[]
  sourceMetadata: SourceMetadata
}
function isExtracted(value: unknown): value is Extracted {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    typeof value.title === 'string' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'markdown' in value &&
    typeof value.markdown === 'string' &&
    'warnings' in value &&
    Array.isArray(value.warnings) &&
    value.warnings.every((entry: unknown) => typeof entry === 'string') &&
    'sourceMetadata' in value &&
    validMetadata(value.sourceMetadata)
  )
}

/** Every worker is terminated and awaited, including successful extraction and cancellation. */
export async function extractHtml(
  html: Buffer,
  url: string,
  contentType: string,
  signal: AbortSignal,
  timeoutMs: number,
  memoryMb: number,
): Promise<Extracted> {
  throwIfAborted(signal)
  const workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? './extract-worker.ts' : './extract-worker.js',
    import.meta.url,
  )
  const worker = new Worker(workerUrl, {
    workerData: { html, url, contentType },
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    execArgv: [],
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await new Promise<Extracted>((resolve, reject) => {
      abort = () => {
        try {
          throwIfAborted(signal)
        } catch (error) {
          reject(error)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => reject(new AppError('TIMEOUT', 'Article extraction exceeded its deadline.', true)),
        timeoutMs,
      )
      worker.once('error', () =>
        reject(new AppError('EXTRACTION_FAILED', 'The isolated article parser failed.')),
      )
      worker.once('exit', (code) =>
        reject(
          new AppError(
            'EXTRACTION_FAILED',
            `The article parser exited before returning a result (${code}).`,
          ),
        ),
      )
      worker.once('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('ok' in message)) {
          reject(new AppError('EXTRACTION_FAILED', 'Invalid article parser response.'))
          return
        }
        if (message.ok === true && 'value' in message && isExtracted(message.value))
          resolve(message.value)
        else
          reject(new AppError('EXTRACTION_FAILED', 'No clean readable article could be extracted.'))
      })
      if (signal.aborted) abort()
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
