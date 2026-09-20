/** Worker entry: one document in, one reply out. The parent terminates it on timeout or cancel. */
import { parentPort, workerData } from 'node:worker_threads'
import { extractFromHtml } from './html.ts'
import { isExtractInput, type ExtractReply } from './types.ts'

function run(): ExtractReply {
  const input: unknown = workerData
  if (!isExtractInput(input)) return { ok: false, reason: 'failed' }
  try {
    return extractFromHtml(input)
  } catch {
    // Parser errors can quote the page; only the fact of failure leaves the worker.
    return { ok: false, reason: 'failed' }
  }
}

parentPort?.postMessage(run())
