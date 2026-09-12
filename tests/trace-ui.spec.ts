import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = await readFile(new URL('../ui/trace.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../ui/trace.js', import.meta.url), 'utf8')
const windows: JSDOM[] = []
const run = {
  id: 'run-1',
  tool: 'websearch',
  status: 'partial',
  started_at: '2026-09-12T00:00:00.000Z',
  ended_at: '2026-09-12T00:00:02.000Z',
  duration_ms: 2000,
  capture_content: true,
  truncated: false,
  input: { query: 'SQLite WAL' },
  output: { status: 'partial', results: [{ title: 'SQLite documentation' }] },
  spans: [
    {
      id: 'span-1',
      parent_id: null,
      name: 'search.collect',
      status: 'partial',
      started_at: '2026-09-12T00:00:00.100Z',
      ended_at: '2026-09-12T00:00:01.900Z',
      duration_ms: 1800,
      input: { query: 'SQLite WAL' },
      output: { candidates: 5 },
    },
    {
      id: 'span-2',
      parent_id: 'span-1',
      name: 'search.provider_request',
      status: 'error',
      started_at: '2026-09-12T00:00:00.200Z',
      ended_at: '2026-09-12T00:00:01.000Z',
      duration_ms: 800,
      input: { engines: ['duckduckgo'] },
      output: { error: { code: 'UPSTREAM_BLOCKED', message: 'CAPTCHA' } },
    },
  ],
}

type ApiHandler = (path: string, init: RequestInit | undefined) => Promise<Response>
async function setup(handler?: ApiHandler) {
  const dom = new JSDOM(
    html.replace('</head>', '<meta name="workbench-token" content="trace-test-token" /></head>'),
    { url: 'http://127.0.0.1:18900/trace', runScripts: 'outside-only' },
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
          search_configured: true,
          engines: [{ engine: 'duckduckgo', status: 'cooling_down', reason: 'CAPTCHA' }],
        }),
      )
    if (handler) return handler(path, init)
    if (path === '/api/traces') return Promise.resolve(Response.json({ runs: [run] }))
    return Promise.resolve(Response.json({ run, spans: run.spans }))
  }
  const initialized: unknown = new Script(`(async () => { ${script}\n })()`).runInContext(
    dom.getInternalVMContext(),
  )
  await initialized
  const document = dom.window.document
  function click(id: string) {
    const control = document.getElementById(id)
    if (!(control instanceof dom.window.HTMLButtonElement)) throw new Error(`Missing button ${id}`)
    control.click()
  }
  function input(id: string, value: string) {
    const control = document.getElementById(id)
    if (
      !(control instanceof dom.window.HTMLInputElement) &&
      !(control instanceof dom.window.HTMLSelectElement)
    )
      throw new Error(`Missing input ${id}`)
    control.value = value
  }
  function submit(query = 'SQLite WAL') {
    input('trace-query', query)
    document
      .getElementById('trace-form')
      ?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  }
  return { dom, document, calls, click, input, submit }
}

afterEach(() => {
  for (const dom of windows.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  }
})

describe('trace explorer actual browser DOM', () => {
  it('renders real nested timing, explains CAPTCHA and replays recorded steps without issuing requests', async () => {
    const { document, calls, click } = await setup()
    expect(document.querySelectorAll('.step-row')).toHaveLength(3)
    expect(document.getElementById('run-summary')?.textContent).toContain('2.00 s')
    expect(
      document.querySelector('[data-step-id="span-2"]')?.classList.contains('step-depth-1'),
    ).toBe(true)
    const requestCount = calls.length
    click('next-step')
    expect(document.getElementById('step-detail')?.textContent).toContain('这一步找到的是网页线索')
    click('next-step')
    expect(document.getElementById('step-detail')?.textContent).toContain('上游要求人机验证')
    expect(document.getElementById('step-detail')?.textContent).toContain('800 ms')
    expect(document.getElementById('step-position')?.textContent).toBe('3 / 3')
    expect(document.getElementById('next-step')?.hasAttribute('disabled')).toBe(true)
    click('previous-step')
    expect(document.getElementById('step-position')?.textContent).toBe('2 / 3')
    expect(calls).toHaveLength(requestCount)
    expect(document.getElementById('engines')?.textContent).toContain('冷却中')
    expect(document.getElementById('run-summary')?.textContent).toContain('服务内无模型')
  })

  it('keeps hostile trace inputs as text and unknown duration explicit', async () => {
    const hostile = '<img src=x onerror="document.body.dataset.executed=1">'
    const redacted = {
      ...run,
      duration_ms: undefined,
      capture_content: false,
      input: { query: { redacted: true, chars: 50 } },
      output: { title: hostile, url: 'javascript:alert(1)' },
      spans: [{ ...run.spans[0], name: hostile }],
    }
    const { document, click } = await setup(async (path) =>
      Response.json(path === '/api/traces' ? { runs: [redacted] } : { run: redacted }),
    )
    expect(document.getElementById('run-summary')?.textContent).toContain('总耗时未知')
    expect(document.querySelector('.run-title')?.textContent).toBe('输入已隐藏 · 50 字符')
    expect(document.getElementById('step-detail')?.textContent).toContain(JSON.stringify(hostile))
    click('next-step')
    expect(document.getElementById('step-detail')?.textContent).toContain(hostile)
    expect(
      document.querySelectorAll('#step-detail img, #steps img, a[href^="javascript:"]'),
    ).toHaveLength(0)
    expect(document.body.dataset.executed).toBeUndefined()
  })

  it('submits search controls and explicit local preview opt-in and follows only matching client correlation while POST is pending', async () => {
    let clientId: string | undefined
    let finish: ((response: Response) => void) | undefined
    const live = {
      ...run,
      id: 'run-live',
      status: 'running',
      duration_ms: undefined,
      ended_at: undefined,
    }
    const other = { ...run, id: 'unrelated', input: { query: 'Same-looking unrelated query' } }
    const { document, calls, input, submit } = await setup((path, init) => {
      if (path === '/api/search') {
        clientId = new Headers(init?.headers).get('X-Trace-Request') ?? undefined
        return new Promise((resolve) => {
          finish = resolve
        })
      }
      if (path === '/api/traces')
        return Promise.resolve(
          Response.json({
            runs: clientId ? [other, { ...live, client_request_id: clientId }] : [],
          }),
        )
      return Promise.resolve(Response.json({ run: live }))
    })
    input('trace-sites', 'sqlite.org，docs.python.org sqlite.org')
    input('trace-ranking', 'bm25_mmr')
    submit()
    await vi.waitFor(
      () =>
        expect(
          document.querySelector('.run-row[aria-pressed="true"]')?.getAttribute('data-run-id'),
        ).toBe('run-live'),
      { timeout: 2500 },
    )
    expect(finish).toBeDefined()
    const request = calls.find((call) => call.path === '/api/search')
    expect(request?.init?.headers).toEqual({
      'X-Workbench-Token': 'trace-test-token',
      'Content-Type': 'application/json',
      'X-Trace-Request': expect.any(String),
      'X-Trace-Content': 'true',
    })
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/u)
    if (typeof request?.init?.body !== 'string') throw new Error('Expected JSON request body')
    expect(JSON.parse(request.init.body)).toEqual({
      query: 'SQLite WAL',
      limit: 5,
      ranking_mode: 'bm25_mmr',
      evidence_mode: 'extract',
      sites: ['sqlite.org', 'docs.python.org'],
      max_evidence_results: 3,
    })
    finish?.(Response.json({ status: 'partial', trace_id: 'run-live' }))
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('部分完成'),
    )
  })

  it('validates URL mode, submits webfetch independently, and can disable content capture', async () => {
    const { dom, document, calls, input, submit } = await setup(async (path) => {
      if (path === '/api/traces') return Response.json({ runs: [] })
      return Response.json({ status: 'ok' })
    })
    input('trace-mode', 'fetch')
    document.getElementById('trace-mode')?.dispatchEvent(new dom.window.Event('change'))
    const capture = document.getElementById('trace-content')
    if (!(capture instanceof dom.window.HTMLInputElement))
      throw new Error('Missing capture checkbox')
    capture.checked = false
    submit('javascript:alert(1)')
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('HTTP(S)'),
    )
    expect(calls.some((call) => call.path === '/api/fetch')).toBe(false)
    submit('https://www.sqlite.org/wal.html')
    await vi.waitFor(() => expect(calls.some((call) => call.path === '/api/fetch')).toBe(true))
    const request = calls.find((call) => call.path === '/api/fetch')
    expect(new Headers(request?.init?.headers).get('X-Trace-Content')).toBe('false')
    if (typeof request?.init?.body !== 'string') throw new Error('Expected JSON request body')
    expect(JSON.parse(request.init.body)).toEqual({
      url: 'https://www.sqlite.org/wal.html',
      format: 'text',
      max_chars: 8000,
    })
    expect(
      [...document.querySelectorAll('.search-control')].every((control) =>
        control.hasAttribute('hidden'),
      ),
    ).toBe(true)
  })

  it('aborts real fetch signals on cancel and does not let late cancelled responses override a new call', async () => {
    const pending: {
      resolve: (response: Response) => void
      signal: AbortSignal | null | undefined
    }[] = []
    const { document, calls, click, submit } = await setup((path, init) => {
      if (path === '/api/traces') return Promise.resolve(Response.json({ runs: [] }))
      return new Promise((resolve) => pending.push({ resolve, signal: init?.signal }))
    })
    submit('first')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    click('cancel-run')
    expect(pending[0]?.signal?.aborted).toBe(true)
    submit('second')
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]?.resolve(Response.json({ status: 'ok' }))
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('本次调用：完成'),
    )
    pending[0]?.resolve(
      Response.json({ status: 'error', error: { message: 'Obsolete old output' } }),
    )
    await vi.waitFor(() =>
      expect(document.getElementById('cancel-run')?.hasAttribute('hidden')).toBe(true),
    )
    expect(document.getElementById('notice')?.textContent).not.toContain('Obsolete')
    expect(document.getElementById('notice')?.textContent).toContain('本次调用：完成')
    expect(calls.filter((call) => call.path === '/api/search')).toHaveLength(2)
  })

  it('cancels pending calls on page exit and stops further automatic observation', async () => {
    let requestSignal: AbortSignal | null | undefined
    const { dom, calls, submit } = await setup((path, init) => {
      if (path === '/api/traces') return Promise.resolve(Response.json({ runs: [] }))
      requestSignal = init?.signal
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        ),
      )
    })
    submit()
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    expect(requestSignal?.aborted).toBe(true)
    const count = calls.length
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(calls).toHaveLength(count)
  })

  it('distinguishes instant queue events from measured wait and keeps URL checks separate from public IP validation', async () => {
    const timingRun = {
      ...run,
      spans: [
        {
          ...run.spans[0],
          id: 'queued',
          name: 'search.queued',
          duration_ms: 0,
          output: { page: 1 },
        },
        {
          ...run.spans[0],
          id: 'started',
          name: 'search.upstream_start',
          duration_ms: 0,
          output: { wait_ms: 730, page: 1 },
        },
        {
          ...run.spans[0],
          id: 'validated',
          name: 'fetch.validate',
          status: 'ok',
          input: { url: 'http://127.0.0.1/' },
          output: { url_policy_passed: true },
        },
      ],
    }
    const { document, click } = await setup(async (path) =>
      Response.json(path === '/api/traces' ? { runs: [timingRun] } : { run: timingRun }),
    )
    click('next-step')
    expect(document.querySelector('[data-step-id="queued"] .step-duration')?.textContent).toBe(
      '事件',
    )
    expect(document.getElementById('step-detail')?.textContent).toContain('进入查询调度队列')
    expect(document.getElementById('step-detail')?.textContent).toContain('不表示等待时长')
    expect(document.getElementById('step-detail')?.textContent).not.toContain('耗时0 ms')
    click('next-step')
    expect(document.getElementById('step-detail')?.textContent).toContain('实际排队等待730 ms')
    click('next-step')
    expect(document.getElementById('step-detail')?.textContent).toContain(
      '这一步通过不表示目标已被证明是公网',
    )
    expect(document.getElementById('step-detail')?.textContent).toContain(
      '真正的 IP 与私网访问检查在后续',
    )
  })

  it('reports an unavailable trace API without inventing history or steps', async () => {
    const { document } = await setup(async () =>
      Response.json(
        { error: { code: 'NOT_FOUND', message: 'Tracing unavailable' } },
        { status: 404 },
      ),
    )
    expect(document.getElementById('notice')?.textContent).toContain('Tracing unavailable')
    expect(document.querySelectorAll('.run-row, .step-row')).toHaveLength(0)
  })
})
