import { throwIfAborted } from '../shared/errors.ts'

/** Abortable FIFO permits. A released slot always wakes the oldest live waiter. */
export class Limiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly maximum: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(ready)
        if (index >= 0) this.waiting.splice(index, 1)
        try {
          throwIfAborted(signal)
        } catch (error) {
          reject(error)
        }
      }
      const ready = () => {
        signal.removeEventListener('abort', abort)
        this.active++
        resolve()
      }
      if (this.active < this.maximum) ready()
      else {
        this.waiting.push(ready)
        signal.addEventListener('abort', abort, { once: true })
      }
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.waiting.shift()?.()
    }
  }
}
