import { Worker } from 'node:worker_threads'
import { WebError, throwIfAborted } from '../errors.ts'
import { isExtractReply, type ExtractInput, type ExtractReply } from './types.ts'

export type { Extracted, ExtractInput, ExtractReply, PageSignals } from './types.ts'
export { extractFromText, type TextExtraction } from './text.ts'

export interface ExtractLimits {
  timeoutMs: number
  memoryMb: number
}

/**
 * A DOM costs roughly a hundred times its source size, so the download limit is far too generous
 * for HTML: documents above this would exhaust the worker heap instead of being read.
 */
export const MAX_HTML_BYTES = 3 * 1024 * 1024

/** Source runs load the .ts worker directly; the published build loads the compiled .js. */
function workerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)
}

function parseFailure(): WebError {
  return new WebError(
    'parse_failed',
    'The page could not be parsed within the memory and time limits; try a simpler version of the page.',
  )
}

function timeoutError(limits: ExtractLimits): WebError {
  const seconds = Math.round(limits.timeoutMs / 100) / 10
  return new WebError(
    'timeout',
    `Converting the page took longer than ${seconds}s; try a smaller page or a text version.`,
  )
}

function abortError(signal: AbortSignal): unknown {
  try {
    throwIfAborted(signal)
  } catch (error) {
    return error
  }
  return new WebError('cancelled', 'The request was cancelled.')
}

async function awaitReply(
  worker: Worker,
  limits: ExtractLimits,
  signal: AbortSignal,
): Promise<ExtractReply> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<ExtractReply>((resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError(limits)), limits.timeoutMs)
      onAbort = () => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: unknown) =>
        isExtractReply(message) ? resolve(message) : reject(parseFailure()),
      )
      // Heap exhaustion and crashes surface here; the detail may quote the page, so it is dropped.
      worker.once('error', () => reject(parseFailure()))
      worker.once('exit', () => reject(parseFailure()))
      if (signal.aborted) onAbort()
    })
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Converts HTML in a worker with a heap limit. The worker is always terminated and awaited,
 * whether it answered, timed out, ran out of memory, or the caller cancelled.
 */
export async function extractHtml(
  input: ExtractInput,
  limits: ExtractLimits,
  signal: AbortSignal,
): Promise<ExtractReply> {
  throwIfAborted(signal)
  if (input.html.byteLength > MAX_HTML_BYTES)
    throw new WebError(
      'too_large',
      `The HTML is larger than the ${MAX_HTML_BYTES / (1024 * 1024)} MB that can be converted; look for a smaller page or a text version.`,
    )
  const worker = new Worker(workerUrl(), {
    workerData: input,
    resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb },
    execArgv: [],
    stdout: true,
    stderr: true,
  })
  try {
    return await awaitReply(worker, limits, signal)
  } finally {
    await worker.terminate()
  }
}
