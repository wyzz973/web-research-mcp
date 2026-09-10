import { request as httpRequest } from 'node:http'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startWorkbench } from '../src/workbench/server.ts'
import { createResearchRuntime } from '../src/tools/runtime.ts'
import { loadConfiguration } from '../src/shared/config.ts'
import type { WebSearchOutput } from '../src/generated/websearch.output.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'research-workbench-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'index.html'), '<html><head></head><body>Research</body></html>')
  const config = loadConfiguration()
  config.storage.directory = join(directory, 'data')
  const runtime = createResearchRuntime(config)
  cleanup.push(() => runtime.close())
  const websearch = vi.fn(runtime.websearch)
  const app = await startWorkbench({
    port: 0,
    uiDirectory: pathToFileURL(`${directory}/`),
    websearch,
    webfetch: runtime.webfetch,
    status: () => ({ engines: [], search_configured: false }),
    evaluation: async () => ({ available: false }),
  })
  cleanup.push(() => app.close())
  const html = await (await fetch(app.url)).text()
  const token = html.match(/name="workbench-token" content="([a-f0-9]+)"/u)?.[1]
  if (!token) throw new Error('No bootstrap session')
  const headers = { 'x-workbench-token': token, 'content-type': 'application/json' }
  return { app, headers, websearch }
}

describe('local workbench HTTP boundary', () => {
  it('boots a protected same-origin session and exposes the real tool failure envelope', async () => {
    const { app, headers } = await fixture()
    const response = await fetch(`${app.url}/api/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'test' }),
    })
    const output = (await response.json()) as WebSearchOutput
    expect(output.status).toBe('error')
    expect(output.error?.code).toBe('CONFIGURATION_REQUIRED')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const status = await fetch(`${app.url}/api/status`, { headers })
    expect(await status.json()).toEqual({ engines: [], search_configured: false })
  })
  it('rejects absent tokens, foreign origins, DNS-rebinding host and static traversal', async () => {
    const { app, headers, websearch } = await fixture()
    for (const overrides of [
      {},
      { ...headers, origin: 'https://example.org' },
      { ...headers, host: 'example.org' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
      { ...headers, 'x-workbench-token': 'ä'.repeat(64) },
      { ...headers, 'x-workbench-token': '0'.repeat(64) },
    ]) {
      // Node fetch may normalize forbidden browser headers; raw HTTP proves the wire boundary.
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${app.url}/api/search`,
          { method: 'POST', headers: overrides },
          (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode ?? 0))
          },
        )
        request.once('error', reject)
        request.end('{"query":"test"}')
      })
      expect(status).toBe(403)
    }
    expect(websearch).not.toHaveBeenCalled()
    expect((await fetch(`${app.url}/%2e%2e/package.json`)).status).toBe(404)
    expect((await fetch(`${app.url}/api/evaluation`)).status).toBe(403)
  })
  it('rejects malformed, oversized and wrong-content-type bodies before tool execution', async () => {
    const { app, headers, websearch } = await fixture()
    for (const body of ['{', JSON.stringify({ query: 'x'.repeat(66_000) })]) {
      expect((await fetch(`${app.url}/api/search`, { method: 'POST', headers, body })).status).toBe(
        400,
      )
    }
    expect(
      (
        await fetch(`${app.url}/api/search`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(400)
    expect(websearch).not.toHaveBeenCalled()
  })
  it('keeps the real SSRF guard enabled for the web adapter', async () => {
    const { app, headers } = await fixture()
    const response = await fetch(`${app.url}/api/fetch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'http://127.0.0.1/' }),
    })
    expect(await response.json()).toMatchObject({
      status: 'error',
      error: { code: 'FETCH_BLOCKED' },
    })
  })
  it('cancels actual handlers on browser disconnect and bounds concurrent requests', async () => {
    const { app, headers, websearch } = await fixture()
    const aborted: AbortSignal[] = []
    websearch.mockImplementation(
      (_input, signal) =>
        new Promise((resolve) => {
          aborted.push(signal)
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                schema_version: '0.3-draft',
                request_id: 'cancel',
                status: 'error',
                query: 'cancel',
                results: [],
                warnings: [],
                providers: [],
                scope: null,
                next_cursor: null,
                evidence_summary: { mode: 'none', target_results: 0, verified_results: 0 },
                error: { code: 'CANCELLED', message: 'Cancelled', retryable: false },
              }),
            { once: true },
          )
        }),
    )
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const pending = controllers.map((controller) =>
      fetch(`${app.url}/api/search`, {
        method: 'POST',
        headers,
        body: '{"query":"test"}',
        signal: controller.signal,
      }).catch(() => null),
    )
    await vi.waitFor(() => expect(aborted).toHaveLength(4))
    expect(
      (await fetch(`${app.url}/api/search`, { method: 'POST', headers, body: '{"query":"test"}' }))
        .status,
    ).toBe(429)
    controllers.forEach((controller) => controller.abort())
    await Promise.all(pending)
    await vi.waitFor(() => expect(aborted.every((signal) => signal.aborted)).toBe(true))
    await app.close()
  })
  it('shutdown waits for cancellation cleanup in an active tool before returning', async () => {
    const { app, headers, websearch } = await fixture()
    let started = false
    let cleaned = false
    websearch.mockImplementation(async (_input, signal) => {
      started = true
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      await nextTurn()
      cleaned = true
      throw new Error('cancelled after cleanup')
    })
    const pending = fetch(`${app.url}/api/search`, {
      method: 'POST',
      headers,
      body: '{"query":"test"}',
    }).catch(() => null)
    await vi.waitFor(() => expect(started).toBe(true))
    await Promise.all([app.close(), app.close()])
    expect(cleaned).toBe(true)
    await pending
  })

  it('shutdown closes incomplete request bodies and does not dispatch a tool', async () => {
    const { app, headers, websearch } = await fixture()
    let connected = false
    const request = httpRequest(`${app.url}/api/search`, {
      method: 'POST',
      headers: { ...headers, 'content-length': '100' },
    })
    const settled = new Promise<void>((resolve) => {
      request.once('error', () => resolve())
      request.once('response', (response) => {
        response.resume()
        response.once('end', resolve)
      })
    })
    request.once('socket', (socket) =>
      socket.once('connect', () => {
        connected = true
      }),
    )
    request.write('{')
    await vi.waitFor(() => expect(connected).toBe(true))
    await app.close()
    await settled
    expect(websearch).not.toHaveBeenCalled()
  })
})
