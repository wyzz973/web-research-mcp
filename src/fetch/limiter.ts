import { throwIfAborted } from '../errors.ts'

export type Limited = <T>(signal: AbortSignal, task: () => Promise<T>) => Promise<T>

/** FIFO permits. A waiter that is cancelled leaves the queue; a released slot wakes the oldest waiter. */
export function createLimiter(maximum: number): Limited {
  let active = 0
  const waiting: (() => void)[] = []

  function acquire(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (active < maximum) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        signal.removeEventListener('abort', abort)
        active += 1
        resolve()
      }
      const abort = (): void => {
        const index = waiting.indexOf(ready)
        if (index >= 0) waiting.splice(index, 1)
        try {
          throwIfAborted(signal)
        } catch (error) {
          reject(error)
        }
      }
      waiting.push(ready)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  return async (signal, task) => {
    await acquire(signal)
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}
