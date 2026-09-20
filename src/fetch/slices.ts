/**
 * Long computations over page text run on the main thread, next to the MCP transport. They are
 * written as generators that yield every so often; the drivers here decide what a yield means.
 */
import { throwIfAborted } from '../errors.ts'

/**
 * Longest stretch of work between two turns of the event loop. Short enough that even a slow
 * machine serves other requests every few tens of milliseconds; a turn itself costs microseconds.
 */
const SLICE_MS = 4

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** For small inputs and tests: runs straight through. */
export function runToEnd<T>(work: Generator<void, T>): T {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}

/**
 * Gives the event loop a turn whenever a few milliseconds of work have gone by, so other
 * requests are served meanwhile and a cancellation takes effect within one slice.
 */
export async function runSliced<T>(work: Generator<void, T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  let sliceStarted = performance.now()
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
    if (performance.now() - sliceStarted < SLICE_MS) continue
    await nextTurn()
    throwIfAborted(signal)
    sliceStarted = performance.now()
  }
}
