import { expect, it, vi } from 'vitest'
import { createFetchRouter } from '../src/fetch/router.ts'
import { AppError } from '../src/shared/errors.ts'
import type { DocumentLoader, LoadedDocument } from '../src/shared/types.ts'
const document: LoadedDocument = {
  url: 'https://example.org/',
  finalUrl: 'https://example.org/',
  title: 'article',
  text: 'content',
  markdown: 'content',
  contentType: 'text/html',
  fetchedAt: '2026-09-12T00:00:00Z',
  extractorVersion: 'fixture',
  warnings: [],
}
function fixture() {
  const staticLoad = vi.fn<DocumentLoader['load']>(async () => document)
  const browserLoad = vi.fn<DocumentLoader['load']>(async () => ({
    ...document,
    fetchBackend: 'crawl4ai',
  }))
  const router = createFetchRouter(
    { load: staticLoad, async close() {} },
    { load: browserLoad, async close() {} },
    { defaultEngine: 'static', allowFallback: true },
  )
  return { router, staticLoad, browserLoad }
}
it('keeps static light and uses Crawl4AI only when explicitly selected', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  expect((await f.router.load(document.url, { signal })).fetchBackend).toBe('static')
  expect(f.browserLoad).not.toHaveBeenCalled()
  expect((await f.router.load(document.url, { signal, engine: 'crawl4ai' })).fetchBackend).toBe(
    'crawl4ai',
  )
  expect(f.staticLoad).toHaveBeenCalledTimes(1)
})
it('auto retries only a readable-text extraction failure and retains rendered backend', async () => {
  const f = fixture()
  f.staticLoad.mockRejectedValue(new AppError('EXTRACTION_FAILED', 'No body'))
  const result = await f.router.load(document.url, {
    signal: new AbortController().signal,
    engine: 'auto',
  })
  expect(result.fetchBackend).toBe('crawl4ai')
  expect(f.browserLoad).toHaveBeenCalledTimes(1)
})
it.each([
  'FETCH_BLOCKED',
  'UPSTREAM_BLOCKED',
  'ROBOTS_DENIED',
  'TIMEOUT',
  'UNSUPPORTED_CONTENT_TYPE',
  'RESPONSE_TOO_LARGE',
])('never turns %s into browser fallback', async (code) => {
  const f = fixture()
  f.staticLoad.mockRejectedValue(new AppError(code, 'Rejected'))
  await expect(
    f.router.load(document.url, { signal: new AbortController().signal, engine: 'auto' }),
  ).rejects.toMatchObject({ code })
  expect(f.browserLoad).not.toHaveBeenCalled()
})
it('does not run another engine after caller cancellation', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.staticLoad.mockImplementation(async () => {
    controller.abort()
    throw new AppError('EXTRACTION_FAILED', 'No body')
  })
  await expect(
    f.router.load(document.url, { signal: controller.signal, engine: 'auto' }),
  ).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(f.browserLoad).not.toHaveBeenCalled()
})

it('auto keeps substantive static HTML but renders a short HTML shell', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  f.staticLoad.mockResolvedValueOnce({
    ...document,
    text: 'Substantive static article text. '.repeat(20),
  })
  expect((await f.router.load(document.url, { signal, engine: 'auto' })).fetchBackend).toBe(
    'static',
  )
  expect(f.browserLoad).not.toHaveBeenCalled()
  expect((await f.router.load(document.url, { signal, engine: 'auto' })).fetchBackend).toBe(
    'crawl4ai',
  )
  expect(f.browserLoad).toHaveBeenCalledTimes(1)
})
