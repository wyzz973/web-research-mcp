/** Real Chromium/Crawl4AI, deterministic broker fixtures. Never enables private network access. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCrawl4aiLoader } from '../dist/fetch/crawl4ai.js'
import { createSnapshotStore } from '../dist/storage/index.js'
import { createWebSearch } from '../dist/tools/websearch.js'
import { createWebFetch } from '../dist/tools/webfetch.js'
import { loadConfiguration } from '../dist/shared/config.js'
const html = `<!doctype html><meta charset="utf-8"><title>Dynamic fixture</title><article><h1 id="title">Loading</h1><div id="body"></div></article><script>
Promise.all([fetch('/data').then(r=>r.json()),fetch('https://private.example/secret').catch(()=>null)]).then(([data])=>{document.getElementById('title').textContent='Rendered after JavaScript';document.getElementById('body').textContent=data.text;});
fetch('/must-not-post',{method:'POST',body:'forbidden'}).catch(()=>{});
new WebSocket('wss://private.example/socket');
</script>`
const expected =
  '真实动态正文🙂。Crawl4AI executed JavaScript and retrieved this JSON through the protected Node gateway. '.repeat(
    20,
  )
const seen = []
let cancelHang
let hangTimer
const dependencies = {
  resolve: async (hostname) => [
    { address: hostname === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 },
  ],
  connect: async (url, address, signal) => {
    assert.notEqual(address.address, '127.0.0.1')
    assert.equal(signal.aborted, false)
    seen.push(url.href)
    const headers = {
      'content-type': url.pathname === '/data' ? 'application/json' : 'text/html; charset=utf-8',
    }
    let status = 200,
      body = ''
    if (url.pathname === '/robots.txt') status = 404
    else if (url.pathname === '/start') {
      status = 302
      headers.location = '/final'
    } else if (url.pathname === '/final') body = html
    else if (url.pathname === '/hang') {
      body = '<script>while(true){}</script><article>Busy renderer</article>'
      hangTimer = setTimeout(() => cancelHang?.(), 500)
    } else if (url.pathname === '/data') body = JSON.stringify({ text: expected })
    else assert.fail('Unexpected browser network request ' + url.pathname)
    return {
      status,
      headers,
      body: (async function* () {
        yield Buffer.from(body)
      })(),
      async close() {},
    }
  },
}
const directory = await mkdtemp(path.join(tmpdir(), 'crawl4ai-smoke-'))
const loader = createCrawl4aiLoader(
  {
    enabled: true,
    waitMs: 1000,
    concurrency: 1,
    deadlineMs: 45000,
    maxCompressedBytes: 5 * 1024 * 1024,
    maxDecompressedBytes: 5 * 1024 * 1024,
    maxRedirects: 5,
    globalConcurrency: 4,
    perHostConcurrency: 2,
    parserTimeoutMs: 5000,
    parserMemoryMb: 128,
    userAgent: 'web-research-crawl4ai-smoke',
  },
  dependencies,
)
const store = createSnapshotStore({ directory, ttlSeconds: 60, maxBytes: 4 * 1024 * 1024 })
try {
  const config = loadConfiguration()
  const fetch = createWebFetch(config, loader, store)
  const output = await fetch(
    { url: 'https://fixture.example/start', engine: 'crawl4ai', format: 'text', max_chars: 100 },
    new AbortController().signal,
  )
  assert.notEqual(output.status, 'error', JSON.stringify(output.error))
  assert.equal(output.fetch_backend, 'crawl4ai')
  assert.equal(output.final_url, 'https://fixture.example/final')
  assert.match(output.content, /Rendered after JavaScript/)
  const snapshot = store.getDocument(output.snapshot_id)
  assert.ok(snapshot.content.includes(expected.trim()))
  assert.ok(snapshot.content.includes('🙂'))
  assert.ok(output.next_cursor)
  const before = seen.length
  const next = await fetch(
    { cursor: output.next_cursor, max_chars: 100 },
    new AbortController().signal,
  )
  assert.equal(next.snapshot_id, output.snapshot_id)
  assert.equal(next.content_sha256, output.content_sha256)
  assert.equal(next.fetch_backend, 'crawl4ai')
  assert.equal(seen.length, before)
  assert.ok(seen.includes('https://fixture.example/start'))
  assert.ok(seen.includes('https://fixture.example/final'))
  assert.ok(seen.includes('https://fixture.example/data'))
  assert.ok(!seen.some((url) => url.includes('private.example') || url.includes('must-not-post')))
  const search = createWebSearch(
    config,
    {
      async searchPage() {
        return {
          sources: [
            {
              url: 'https://fixture.example/start',
              title: '真实动态正文',
              snippet: 'JavaScript rendered evidence',
              publishedAt: null,
              engines: ['brave'],
            },
          ],
          errors: [],
          exhausted: true,
        }
      },
      async close() {},
    },
    loader,
    store,
  )
  const evidence = await search(
    {
      query: '真实动态正文',
      language: 'zh',
      sites: ['fixture.example'],
      evidence_mode: 'extract',
      fetch_engine: 'crawl4ai',
      max_evidence_results: 1,
    },
    new AbortController().signal,
  )
  assert.notEqual(evidence.status, 'error', JSON.stringify(evidence.error))
  assert.equal(evidence.results[0].fetch_backend, 'crawl4ai')
  assert.equal(evidence.results[0].evidence_status, 'verified')
  for (const quote of evidence.results[0].evidence) {
    const saved = store.getDocument(quote.snapshot_id)
    assert.equal(
      Array.from(saved.content).slice(quote.start_char, quote.end_char).join(''),
      quote.quote,
    )
  }
  const abort = new AbortController()
  cancelHang = () => abort.abort()
  const cancelStarted = Date.now()
  await assert.rejects(
    loader.load('https://fixture.example/hang', { signal: abort.signal }),
    (error) => error?.code === 'CANCELLED',
  )
  assert.ok(
    Date.now() - cancelStarted < 15000,
    'Cancellation and owned-browser cleanup exceeded its bound',
  )
  console.log(
    JSON.stringify({
      status: 'passed',
      engine: 'crawl4ai',
      dynamic_text: true,
      redirect_final: output.final_url,
      ssrf_blocked: true,
      post_blocked: true,
      snapshot_continuation: true,
      busy_renderer_cancelled: true,
      search_evidence: true,
      network_requests: seen.length,
    }),
  )
} finally {
  clearTimeout(hangTimer)
  await loader.close()
  store.close()
  await rm(directory, { recursive: true, force: true })
}
