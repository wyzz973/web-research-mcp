import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8')
const windows: JSDOM[] = []
const baseResult = {
  source_id: 'source-1',
  title: 'SQLite concurrency',
  url: 'https://sqlite.org/wal.html',
  snippet: 'Search summary is distinct from fetched evidence.',
  evidence_status: 'verified',
  confidence: { level: 'high', fact_probability: null },
  relevance: { score: 0.5 },
  evidence: [
    {
      id: 'evidence-1',
      quote: 'Readers do not block writers.',
      start_char: 10,
      end_char: 39,
      snapshot_id: 'snapshot-1',
      content_sha256: 'snapshot-hash',
      verification: 'exact_match',
      snapshot_cursor: 'document-cursor',
      fetched_at: '2026-09-10T00:00:00Z',
    },
  ],
  next_evidence_cursor: 'evidence-cursor',
  source_metadata: { hostname: 'sqlite.org', site_name: 'SQLite', metadata_source: 'html' },
}

type ApiHandler = (path: string, init: RequestInit | undefined) => Promise<Response>

async function setup(handler?: ApiHandler, evaluation: unknown = { available: false }) {
  const dom = new JSDOM(
    html.replace('</head>', '<meta name="workbench-token" content="local-test-token" /></head>'),
    {
      url: 'http://127.0.0.1:18889',
      runScripts: 'outside-only',
    },
  )
  windows.push(dom)
  const calls: { path: string; init: RequestInit | undefined }[] = []
  dom.window.fetch = (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ path, init })
    if (path === '/api/status')
      return Promise.resolve(
        Response.json({
          service: 'ready',
          crawl4ai: { installed: false, version: '0.9.3' },
          search_configured: true,
          engines: [{ id: 'google', status: 'blocked', message: 'Challenge observed' }],
        }),
      )
    if (path === '/api/evaluation') return Promise.resolve(Response.json(evaluation))
    return handler
      ? handler(path, init)
      : Promise.resolve(Response.json({ status: 'ok', results: [baseResult], warnings: [] }))
  }
  const initialized: unknown = new Script(`(async () => { ${script}\n })()`).runInContext(
    dom.getInternalVMContext(),
  )
  await initialized
  const document = dom.window.document
  function input(id: string, value: string) {
    const control = document.getElementById(id)
    if (
      !(control instanceof dom.window.HTMLInputElement) &&
      !(control instanceof dom.window.HTMLSelectElement)
    )
      throw new Error(`Missing form input ${id}`)
    control.value = value
  }
  function click(text: string) {
    const control = [...document.querySelectorAll('button')].find(
      (node) => node.textContent === text,
    )
    if (!control) throw new Error(`Missing button: ${text}`)
    control.click()
  }
  function submit() {
    input('query', 'SQLite WAL')
    document
      .getElementById('search-form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  }
  return { dom, document, calls, input, click, submit }
}

afterEach(() => {
  windows.splice(0).forEach((dom) => dom.window.close())
})

describe('local workbench browser behavior', () => {
  it('sends domain and ranking controls with same-origin token and displays partial original evidence separately', async () => {
    const { document, calls, input, submit } = await setup(async () =>
      Response.json({
        status: 'partial',
        results: [baseResult],
        warnings: ['Google is cooling down'],
        evidence_summary: { target_results: 3, verified_results: 1 },
      }),
    )
    input('sites', 'sqlite.org， docs.python.org sqlite.org')
    input('ranking', 'bm25_mmr')
    input('fetch-engine', 'crawl4ai')
    submit()
    await vi.waitFor(() =>
      expect(document.querySelector('blockquote')?.textContent).toBe(
        'Readers do not block writers.',
      ),
    )
    const request = calls.find((call) => call.path === '/api/search')
    expect(request?.init?.headers).toEqual({
      'X-Workbench-Token': 'local-test-token',
      'Content-Type': 'application/json',
    })
    expect(request?.init?.body).toBe(
      JSON.stringify({
        query: 'SQLite WAL',
        limit: 8,
        language: 'auto',
        ranking_mode: 'bm25_mmr',
        evidence_mode: 'extract',
        sites: ['sqlite.org', 'docs.python.org'],
        max_evidence_results: 3,
        fetch_engine: 'crawl4ai',
      }),
    )
    expect(document.getElementById('notice')?.textContent).toContain('Google is cooling down')
    expect(document.querySelector('.snippet')?.textContent).toBe(baseResult.snippet)
    expect(document.getElementById('evidence-panel')?.textContent).toContain('不是事实正确概率')
    expect(document.getElementById('search-meta')?.textContent).toContain('1/3')
    expect(document.getElementById('engines')?.textContent).toContain('上游封锁')
  })

  it('shows experimental rank movement and missing evaluation labels without invented scores', async () => {
    const { document, submit } = await setup(
      async () =>
        Response.json({
          status: 'ok',
          results: [
            {
              ...baseResult,
              rank: 1,
              ranking: { method: 'bm25_mmr', score: 1.2345, original_rank: 4, corpus_size: 20 },
            },
          ],
        }),
      {
        generated_at: '2026-09-10T00:00:00Z',
        coverage: { catalog_queries: 60, recorded_queries: 10, judged_queries: 0 },
        summary: {
          upstream: { ndcg_at_10: null, mrr_at_10: null, ranking_p95_ms: 0.012 },
          bm25: { ndcg_at_10: null, mrr_at_10: null, ranking_p95_ms: 0.143 },
        },
        caveats: ['No human relevance judgments'],
      },
    )
    expect(document.querySelectorAll('.evaluation-table tbody tr')).toHaveLength(2)
    expect(document.querySelector('.evaluation-table')?.textContent).toContain('未测')
    expect(document.getElementById('evaluation')?.textContent).toContain('Agent 标注不等于人工金标')
    submit()
    await vi.waitFor(() =>
      expect(document.querySelector('.ranking-note')?.textContent).toContain('原始 #4 → 当前 #1'),
    )
    expect(document.getElementById('evidence-panel')?.textContent).toContain('不是概率')
    expect(document.getElementById('evidence-panel')?.textContent).toContain('候选池 20 条')
  })

  it('keeps hostile upstream markup as text and rejects unsafe source and asset protocols', async () => {
    const hostile = '<img src=x onerror="document.body.dataset.executed=1">'
    const { document, submit } = await setup(async () =>
      Response.json({
        status: 'ok',
        results: [
          {
            ...baseResult,
            title: hostile,
            url: 'javascript:alert(1)',
            snippet: '<script>alert(1)</script>',
            evidence: [{ ...baseResult.evidence[0], quote: hostile }],
            source_metadata: {
              hostname: 'safe.example',
              favicon_url: 'data:image/svg+xml,<svg onload=alert(1)>',
              logo_url: 'javascript:alert(1)',
            },
          },
        ],
      }),
    )
    submit()
    await vi.waitFor(() => expect(document.querySelector('blockquote')?.textContent).toBe(hostile))
    expect(document.querySelectorAll('blockquote img')).toHaveLength(0)
    expect(document.querySelectorAll('.source-icon img')).toHaveLength(0)
    expect(document.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0)
    expect(document.body.dataset.executed).toBeUndefined()
    expect(document.querySelector('.result-title')?.textContent).toBe(hostile)
  })

  it('reads frozen document pages using returned cursors and keeps evidence view separate', async () => {
    const { document, calls, click, submit } = await setup(async (path, init) => {
      if (path === '/api/search') return Response.json({ status: 'ok', results: [baseResult] })
      if (
        init?.body ===
        JSON.stringify({ cursor: 'document-cursor', format: 'text', max_chars: 12000 })
      )
        return Response.json({
          status: 'ok',
          view: 'document',
          content: 'First page.',
          snapshot_id: 'snapshot-1',
          content_sha256: 'snapshot-hash',
          next_cursor: 'document-page-2',
        })
      if (
        init?.body ===
        JSON.stringify({ cursor: 'document-page-2', format: 'text', max_chars: 12000 })
      )
        return Response.json({
          status: 'ok',
          view: 'document',
          content: 'Second page.',
          snapshot_id: 'snapshot-1',
          content_sha256: 'snapshot-hash',
          next_cursor: null,
        })
      return Response.json({
        status: 'ok',
        view: 'evidence',
        evidence: [{ ...baseResult.evidence[0], quote: 'Another related paragraph.' }],
        snapshot_id: 'snapshot-1',
        next_cursor: null,
      })
    })
    submit()
    await vi.waitFor(() => expect(document.querySelector('blockquote')).not.toBeNull())
    click('读取这份完整快照 ↗')
    await vi.waitFor(() =>
      expect(document.querySelector('.document')?.textContent).toBe('First page.'),
    )
    click('继续读取下一页 ↓')
    await vi.waitFor(() =>
      expect([...document.querySelectorAll('.document')].map((node) => node.textContent)).toEqual([
        'First page.',
        'Second page.',
      ]),
    )
    expect(document.querySelector('[data-continuation]')).toBeNull()
    click('更多相关原文 ↓')
    await vi.waitFor(() =>
      expect(document.getElementById('read-area')?.textContent).toContain(
        'Another related paragraph.',
      ),
    )
    expect(document.querySelector('.document')).toBeNull()
    expect(document.getElementById('read-area')?.textContent).toContain('非连续全文')
    const reads = calls.filter((call) => call.path === '/api/fetch')
    expect(reads).toHaveLength(3)
    for (const request of reads) {
      if (typeof request.init?.body !== 'string') throw new Error('Expected JSON request body')
      expect(JSON.parse(request.init.body)).not.toHaveProperty('engine')
    }
  })

  it('uses the selected backend for a fresh URL, omits it for search without evidence, and reports installation failures', async () => {
    const { dom, document, calls, input, submit, click } = await setup(async (path) =>
      Response.json(
        path === '/api/search'
          ? {
              status: 'ok',
              results: [
                {
                  ...baseResult,
                  evidence: [],
                  evidence_status: 'not_requested',
                  next_evidence_cursor: null,
                },
              ],
            }
          : {
              status: 'error',
              error: { code: 'CONFIGURATION_REQUIRED', message: 'Run pnpm crawl4ai:setup' },
            },
      ),
    )
    expect(document.getElementById('crawl4ai-hint')?.textContent).toContain('pnpm crawl4ai:setup')
    input('fetch-engine', 'auto')
    const extract = document.getElementById('extract')
    if (!(extract instanceof dom.window.HTMLInputElement)) throw new Error('Missing extract input')
    extract.checked = false
    submit()
    await vi.waitFor(() => expect(document.querySelector('.source-heading')).not.toBeNull())
    const search = calls.find((call) => call.path === '/api/search')
    if (typeof search?.init?.body !== 'string') throw new Error('Expected search JSON')
    expect(JSON.parse(search.init.body)).not.toHaveProperty('fetch_engine')
    click('抓取网页原文 ↗')
    await vi.waitFor(() =>
      expect(document.getElementById('read-status')?.textContent).toContain('pnpm crawl4ai:setup'),
    )
    const request = calls.find((call) => call.path === '/api/fetch')
    if (typeof request?.init?.body !== 'string') throw new Error('Expected fetch JSON')
    expect(JSON.parse(request.init.body)).toEqual({
      url: baseResult.url,
      format: 'text',
      max_chars: 12000,
      engine: 'auto',
    })
  })

  it('cancels actual request signals and shows cancellation without a false successful result', async () => {
    const { document, calls, submit, click } = await setup(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
        }),
    )
    submit()
    await vi.waitFor(() => expect(calls.some((call) => call.path === '/api/search')).toBe(true))
    click('取消')
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toBe('已取消本次搜索。'),
    )
    expect(calls.find((call) => call.path === '/api/search')?.init?.signal?.aborted).toBe(true)
    expect(document.querySelectorAll('.result')).toHaveLength(0)
  })

  it('does not let an old reading overwrite a newly selected source', async () => {
    let resolveRead: ((value: Response) => void) | undefined
    const { document, submit, click } = await setup((path) => {
      if (path === '/api/search')
        return Promise.resolve(
          Response.json({
            status: 'ok',
            results: [baseResult, { ...baseResult, source_id: 'source-2', title: 'Second source' }],
          }),
        )
      return new Promise((resolve) => {
        resolveRead = resolve
      })
    })
    submit()
    await vi.waitFor(() => expect(document.querySelector('blockquote')).not.toBeNull())
    click('读取这份完整快照 ↗')
    await vi.waitFor(() => expect(resolveRead).toBeDefined())
    click('Second source')
    resolveRead?.(
      Response.json({ status: 'ok', view: 'document', content: 'Obsolete first source body' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('.source-heading')?.textContent).toBe('Second source')
    expect(document.getElementById('evidence-panel')?.textContent).not.toContain(
      'Obsolete first source body',
    )
  })
})
