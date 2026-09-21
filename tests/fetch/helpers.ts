import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { loadConfig, type Config } from '../../src/config.ts'
import type { FetchResult, Store } from '../../src/contract.ts'
import { foldText, type Folded } from '../../src/fetch/find.ts'
import { createReader, type Reader } from '../../src/fetch/index.ts'
import type { NetworkDependencies } from '../../src/net/safe-http.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'

export interface Route {
  body?: string | Buffer
  status?: number
  headers?: Record<string, string>
  /** Send the body, then keep the response open until the request is aborted. */
  hang?: boolean
}

export type Routes = Record<string, Route | ((url: URL) => Route)>

export interface Harness {
  reader: Reader
  store: Store
  config: Config
  /** Every page URL that was actually connected to, in order. robots.txt requests are kept apart. */
  requests: string[]
  robotsRequests: string[]
  /** Responses handed out and responses closed; equal once every connection was released. */
  connections: { opened: number; closed: number }
  /** When each request started, in milliseconds since the harness was created. */
  startedAt: { url: string; ms: number }[]
  clock: { now: Date }
  fetch(request: Record<string, unknown>, signal?: AbortSignal): Promise<FetchResult>
  close(): void
}

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/pages/${name}`, import.meta.url))
}

interface Recorder {
  requests: string[]
  robotsRequests: string[]
  connections: { opened: number; closed: number }
  startedAt: { url: string; ms: number }[]
  epoch: number
}

function network(routes: Routes, recorder: Recorder): NetworkDependencies {
  return {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (url, _address, signal) => {
      recorder.startedAt.push({ url: url.href, ms: Date.now() - recorder.epoch })
      if (url.pathname === '/robots.txt') recorder.robotsRequests.push(url.href)
      else recorder.requests.push(url.href)
      const match = routes[url.href] ?? routes[url.pathname]
      const route = typeof match === 'function' ? match(url) : match
      const body = Buffer.from(route?.body ?? '')
      recorder.connections.opened += 1
      return {
        status: route ? (route.status ?? 200) : 404,
        headers: { 'content-type': 'text/html; charset=utf-8', ...route?.headers },
        body: (async function* () {
          yield body
          if (!route?.hang) return
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
          )
        })(),
        close: async () => {
          recorder.connections.closed += 1
        },
      }
    },
  }
}

export async function createHarness(
  routes: Routes,
  adjust: (config: Config) => void = () => {},
  hostIntervalMs = 0,
): Promise<Harness> {
  const config = loadConfig({})
  adjust(config)
  const store = await createSqliteStore(':memory:')
  const recorder: Recorder = {
    requests: [],
    robotsRequests: [],
    connections: { opened: 0, closed: 0 },
    startedAt: [],
    epoch: Date.now(),
  }
  const clock = { now: new Date('2026-09-21T03:00:00.000Z') }
  const reader = createReader({
    config,
    store,
    network: network(routes, recorder),
    now: () => clock.now,
    hostIntervalMs,
  })
  return {
    reader,
    store,
    config,
    requests: recorder.requests,
    robotsRequests: recorder.robotsRequests,
    connections: recorder.connections,
    startedAt: recorder.startedAt,
    clock,
    fetch: (request, signal) => reader.fetch(request, signal ?? new AbortController().signal),
    close: () => store.close(),
  }
}

/** The contract every reading mode must keep: each part is a verbatim slice of its snapshot. */
export function expectVerbatim(result: FetchResult, store: Store): void {
  for (const page of result.pages) {
    if (page.status !== 'ok') continue
    const snapshot = store.getSnapshot(page.snapshot ?? '')
    expect(snapshot, `snapshot of page ${page.n}`).toBeDefined()
    let previousEnd = -1
    for (const part of [...page.parts].sort((left, right) => left.start - right.start)) {
      expect(part.text).toBe(snapshot?.markdown.slice(part.start, part.end))
      expect(part.start).toBeGreaterThanOrEqual(previousEnd)
      previousEnd = part.end
    }
    expect(page.total_chars).toBe(snapshot?.markdown.length)
    expect(page.shown_chars).toBe(page.parts.reduce((sum, part) => sum + part.text.length, 0))
  }
}

const TOPICS = [
  'caching',
  'routing',
  'logging',
  'storage',
  'security',
  'billing',
  'search',
  'queues',
]

/** A numbered manual: `chapters` chapters with three sections each, every section distinct. */
export function manualHtml(chapters: number): string {
  const body: string[] = [
    '<h1>Platform manual</h1>',
    '<p>This manual describes every subsystem of the platform in one long page.</p>',
  ]
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    const topic = TOPICS[(chapter - 1) % TOPICS.length] ?? 'misc'
    body.push(`<h2>${chapter}. About ${topic} ${chapter}</h2>`)
    body.push(
      `<p>Chapter ${chapter} introduces the ${topic} subsystem and explains when operators need to care about it.</p>`,
    )
    for (let section = 1; section <= 3; section += 1) {
      body.push(`<h3>${chapter}.${section} ${topic} detail ${section}</h3>`)
      body.push(
        `<p>${`The ${topic} subsystem, part ${chapter}.${section}, keeps its state in a replicated table and reconciles it on every restart. `.repeat(4)}</p>`,
      )
      body.push(
        `<pre><code class="language-sh">platform ${topic} inspect --chapter ${chapter} --section ${section}\n# exit code 0 means healthy</code></pre>`,
      )
    }
  }
  return `<!doctype html><html><head><title>Platform manual</title></head><body><article>${body.join('\n')}</article></body></html>`
}

/** How many turns the event loop got while `operation` ran. Independent of how fast the machine is. */
export async function countTurns<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; turns: number }> {
  let turns = 0
  let running = true
  const tick = (): void => {
    turns += 1
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    return { value: await operation(), turns }
  } finally {
    running = false
  }
}

/** The visible-text map of a text that must be small enough to have one. */
export function mustFold(text: string, limit?: number): Folded {
  const folded = foldText(text, limit)
  if (!folded) throw new Error('the text is too large for a visible-text map')
  return folded
}

/** Counts the steps taken from a generator, so that "how much work was done" needs no clock. */
export function counting<T>(work: Generator<void, T>): {
  work: Generator<void, T>
  steps: () => number
} {
  let steps = 0
  function* counted(): Generator<void, T> {
    for (;;) {
      const step = work.next()
      steps += 1
      if (step.done) return step.value
      yield
    }
  }
  return { work: counted(), steps: () => steps }
}

/** CPU time this process spent in `run`, in milliseconds: user plus system, all threads. */
function cpuMs(run: () => void): number {
  const before = process.cpuUsage()
  run()
  const spent = process.cpuUsage(before)
  return (spent.user + spent.system) / 1000
}

const KB = 1024
const MB = 1024 * KB
const RUNS = 5
/**
 * Below this the measurement is mostly noise. Well above the granularity of process CPU time on
 * Windows, which is about 16 ms: a Windows runner read 10.4 where this machine reads 4. It
 * cannot be raised much further without the cheaper steps needing inputs of many megabytes.
 */
const MEASURABLE_MS = 30
/**
 * How much four times the input may cost. Linear is about 4 and quadratic about 16; what these
 * tests exist to catch was 50 to 900 times slower, so the room here is for the clock, not for a
 * regression.
 */
export const MAX_GROWTH = 12
/** Only a fuse: far above any honest run, it catches a return to tens of seconds. */
export const FUSE_MS = 30_000

/**
 * Cost of `large` relative to `small`, or undefined when `small` is too fast to measure.
 *
 * The clock is the CPU time of this process, not the wall: vitest runs every test file in its
 * own process and the tests of a file one after another, so other test files and other programs
 * on a loaded machine do not show up in it. The two are measured alternately, so a change in
 * machine state hits both alike, and the smallest of several runs of each is compared.
 */
export function cpuRatio(small: () => void, large: () => void): number | undefined {
  let smallMs = Number.POSITIVE_INFINITY
  let largeMs = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < RUNS; attempt += 1) {
    smallMs = Math.min(smallMs, cpuMs(small))
    largeMs = Math.min(largeMs, cpuMs(large))
  }
  return smallMs >= MEASURABLE_MS ? largeMs / smallMs : undefined
}

/**
 * Like `cpuRatio`, but only what the setup returns is timed. Where building the input costs more
 * than the thing under test, and costs it unevenly, its noise lands in the ratio: a parser that
 * is a little worse than linear can push an honest pass over the limit on one machine and not on
 * another.
 */
export function cpuRatioOf(
  small: () => () => void,
  large: () => () => void,
  runs = 3,
  minMs = 25,
): number | undefined {
  let smallMs = Number.POSITIVE_INFINITY
  let largeMs = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < runs; attempt += 1) {
    smallMs = Math.min(smallMs, cpuMs(small()))
    largeMs = Math.min(largeMs, cpuMs(large()))
  }
  return smallMs >= minMs ? largeMs / smallMs : undefined
}

/**
 * `growth` for work whose input has to be built first; the building is not counted, and there
 * are fewer runs than `cpuRatio` takes: here every run builds an input of its own, and holding
 * several parsed documents at once is what exhausts the memory of a CI runner.
 */
export function growthOf(
  prepare: (size: number) => () => void,
  sizes: readonly number[],
): number | undefined {
  for (const base of sizes) {
    const ratio = cpuRatioOf(
      () => prepare(base),
      () => prepare(4 * base),
    )
    if (ratio !== undefined) return ratio
  }
  return undefined
}

/**
 * Cost of a fourfold larger input relative to the smaller one: about 4 when the work is linear,
 * about 16 when it is quadratic. Undefined when even the largest size is too fast to measure.
 *
 * It starts small and grows only while the smaller side is too fast to measure: the ratio tells
 * linear from quadratic at any size, so the size is chosen for the measurement, not for the
 * input. A CI runner is several times slower than this machine and has a fraction of its memory,
 * and a test that needs a gigabyte to prove a point fails there for the wrong reason. `sizes` is
 * a ladder in whatever unit `make` takes: characters by default, elements where a parser is the
 * expensive part.
 */
export function growth(
  make: (size: number) => string,
  run: (input: string) => void,
  sizes: readonly number[] = [64 * KB, 256 * KB, MB, 2 * MB],
): number | undefined {
  for (const base of sizes) {
    const small = make(base)
    const large = make(4 * base)
    const ratio = cpuRatio(
      () => run(small),
      () => run(large),
    )
    if (ratio !== undefined) return ratio
  }
  return undefined
}
