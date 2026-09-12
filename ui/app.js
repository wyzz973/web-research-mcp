const byId = (id) => document.getElementById(id)
const state = {
  search: null,
  input: null,
  results: [],
  selected: null,
  searchController: null,
  readController: null,
  readVersion: 0,
  activeRead: null,
}
const labels = {
  ok: '可用',
  ready: '就绪',
  healthy: '已观察可用',
  half_open: '恢复探测中',
  no_error_reported: '未报告错误，未确认结果',
  results: '已返回结果',
  failure: '失败观察',
  UPSTREAM_BLOCKED: '上游封锁或验证码',
  UPSTREAM_UNAVAILABLE: '上游暂不可用',
  TIMEOUT: '请求超时',
  CONFIGURATION_REQUIRED: '搜索尚未配置',
  INVALID_ARGUMENT: '查询参数不符合要求',
  BUDGET_EXCEEDED: '超出本次资源预算',
  skipped_budget: '超出补抓预算',
  no_match: '未找到相关原文',
  out_of_scope: '跳转超出域范围',
  partial: '部分完成',
  empty: '没有结果',
  error: '失败',
  unknown: '尚未观察',
  blocked: '上游封锁',
  cooling_down: '冷却中',
  cooldown: '冷却中',
  unavailable: '不可用',
  timeout: '超时',
  disabled: '未启用',
  skipped: '已跳过',
  high: '高',
  medium: '中',
  low: '低',
  none: '无',
  verified: '已核验',
  not_requested: '未请求',
  not_attempted: '未抓取',
  failed: '抓取失败',
}
const label = (value) => labels[value] || String(value ?? '未知')
const array = (value) => (Array.isArray(value) ? value : [])
const string = (value) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
const percent = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '未知'
const timestamp = (value) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '未提供'

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

function safeUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function link(text, value) {
  const url = safeUrl(value)
  if (!url) return element('span', '', text)
  const node = element('a', '', text)
  node.href = url
  node.target = '_blank'
  node.rel = 'noopener noreferrer'
  node.referrerPolicy = 'no-referrer'
  return node
}

function button(text, handler, className = 'text-button') {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', handler)
  return node
}

function sourceLine(metadata = {}, url = '') {
  const row = element('div', 'source-line')
  const hostname = metadata.hostname || safeUrl(url)?.split('/')[2] || '未知来源'
  const icon = element('span', 'source-icon', hostname.slice(0, 1).toUpperCase())
  const asset = safeUrl(metadata.favicon_url || metadata.logo_url)
  if (asset) {
    const image = element('img')
    image.alt = ''
    image.referrerPolicy = 'no-referrer'
    image.loading = 'lazy'
    image.addEventListener(
      'error',
      () => icon.replaceChildren(document.createTextNode(hostname.slice(0, 1).toUpperCase())),
      { once: true },
    )
    image.src = asset
    icon.replaceChildren(image)
  }
  row.append(
    icon,
    element(
      'span',
      'source-label',
      metadata.site_name && metadata.site_name !== hostname
        ? `${metadata.site_name} · ${hostname}`
        : hostname,
    ),
  )
  return row
}

function notice(text, isError = false) {
  const node = byId('notice')
  node.textContent = text
  node.classList.toggle('error', isError)
  node.hidden = !text
}

function issues(output) {
  const warnings = array(output.warnings).map(string)
  return [
    ...new Set(
      [
        output.error ? `${output.error.code || 'ERROR'} · ${output.error.message || ''}` : '',
        ...warnings,
        ...(warnings.length
          ? []
          : array(output.providers)
              .filter((provider) => provider.status !== 'ok' && provider.message)
              .map((provider) => `${provider.id}: ${provider.message}`)),
      ].filter(Boolean),
    ),
  ]
}

function searchNotice(output) {
  const messages = issues(output)
  let summary = `已返回 ${state.results.length} 条结果。点击来源检查原文与溯源。`
  if (output.status === 'error')
    summary = `搜索未完成：${label(output.error?.code)}。展开诊断查看详情。`
  else if (output.status === 'empty')
    summary = '本次查询没有符合范围的结果。可以调整关键词或域名范围。'
  else if (output.status === 'partial') summary = '部分搜索或原文提取未完成，已保留可用结果。'
  const joined = messages.join(' ')
  if (/engine|upstream|cooling|suspend|captcha|blocked/iu.test(joined))
    summary += ' 部分上游引擎受限。'
  if (/budget|candidate|pool.*limit/iu.test(joined)) summary += ' 候选采集或原文提取已达本次预算。'
  notice(summary, output.status === 'error' || output.status === 'partial')
  if (messages.length) {
    const details = element('details', 'notice-details')
    details.append(element('summary', '', `原始诊断详情 · ${messages.length} 项`))
    appendWarnings(details, messages)
    byId('notice').append(details)
  }
}

const rankingName = (mode) =>
  ({ upstream: '上游顺序', bm25: 'BM25', bm25_mmr: 'BM25 + MMR' })[mode] || mode

function rankingNote(result) {
  if (!result.ranking) return '上游顺序 · 保留候选原始名次'
  const rank = result.ranking
  const score = typeof rank.score === 'number' ? rank.score.toFixed(3) : '未知'
  return `${rankingName(rank.method)} · 原始 #${rank.original_rank} → 当前 #${result.rank} · 得分 ${score} · 候选池 ${rank.corpus_size} 条`
}

async function api(path, body, signal) {
  const headers = {
    'X-Workbench-Token': document.querySelector('meta[name="workbench-token"]')?.content || '',
  }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  })
  let output
  try {
    output = await response.json()
  } catch {
    throw new Error(`本地服务返回非 JSON 响应（HTTP ${response.status}）`)
  }
  if (!response.ok)
    throw new Error(
      `${output.error?.code || `HTTP ${response.status}`} · ${output.error?.message || output.message || '请求失败'}`,
    )
  return output
}

function showJson(title, value) {
  byId('json-title').textContent = title
  byId('json-content').textContent = JSON.stringify(value, null, 2)
  byId('json-dialog').showModal()
}

function setBusy(busy) {
  byId('search-button').disabled = busy
  byId('search-button').textContent = busy ? '正在检索…' : '开始搜索 ↗'
  byId('cancel-button').hidden = !busy
  byId('more-results').disabled = busy
  byId('results').setAttribute('aria-busy', String(busy))
}

async function search(continuation = false) {
  state.searchController?.abort()
  state.readController?.abort()
  state.readVersion += 1
  const controller = new AbortController()
  state.searchController = controller
  const started = performance.now()
  let input
  if (continuation) input = { ...state.input, cursor: state.search.next_cursor }
  else {
    input = {
      query: byId('query').value.trim(),
      limit: Number(byId('limit').value),
      language: byId('language').value,
      ranking_mode: byId('ranking').value,
      evidence_mode: byId('extract').checked ? 'extract' : 'none',
    }
    const sites = [
      ...new Set(
        byId('sites')
          .value.split(/[\s,，]+/u)
          .filter(Boolean),
      ),
    ]
    if (sites.length) input.sites = sites
    if (byId('extract').checked) {
      input.max_evidence_results = 3
      input.fetch_engine = byId('fetch-engine').value
    }
    if (!input.query) {
      byId('query').focus()
      return
    }
    state.input = input
    state.search = null
    state.results = []
    state.selected = null
    byId('search-json').disabled = true
    byId('result-count').textContent = '—'
    byId('search-meta').replaceChildren()
    byId('more-results').hidden = true
    byId('results').replaceChildren(
      element('p', 'read-status', '正在查询上游搜索引擎并按预算提取原文…'),
    )
    byId('evidence-panel').replaceChildren(
      element('p', 'read-status', '搜索完成后，选择来源查看原文证据。'),
    )
  }
  setBusy(true)
  notice('搜索进行中。免费上游可能需要等待；你可以随时取消。')
  try {
    const output = await api('/api/search', input, controller.signal)
    if (controller !== state.searchController) return
    state.search = output
    state.results = continuation
      ? [...state.results, ...array(output.results)]
      : array(output.results)
    byId('search-json').disabled = false
    byId('result-count').textContent = String(state.results.length).padStart(2, '0')
    const summary = output.evidence_summary
    byId('search-meta').textContent =
      `${label(output.status)} · ${((performance.now() - started) / 1000).toFixed(1)} 秒${summary ? ` · 本页原文核验 ${summary.verified_results}/${summary.target_results}` : ''}${output.scope?.sites?.length ? ` · 限定 ${output.scope.sites.join('、')}` : ''}`
    renderResults()
    byId('more-results').hidden = !output.next_cursor
    searchNotice(output)
    if (state.results.length)
      selectResult(
        state.selected && state.results.includes(state.selected)
          ? state.selected
          : state.results[0],
        false,
      )
    await refreshStatus()
  } catch (error) {
    if (controller !== state.searchController) return
    notice(
      error.name === 'AbortError' ? '已取消本次搜索。' : `搜索未完成：${error.message}`,
      error.name !== 'AbortError',
    )
    if (!state.results.length)
      byId('results').replaceChildren(
        element(
          'p',
          'read-status',
          error.name === 'AbortError' ? '本次搜索已取消。' : '没有收到可展示的搜索结果。',
        ),
      )
  } finally {
    if (controller === state.searchController) {
      state.searchController = null
      setBusy(false)
    }
  }
}

function renderResults() {
  const container = byId('results')
  container.replaceChildren()
  if (!state.results.length) {
    container.append(
      element(
        'p',
        'read-status',
        state.search?.status === 'error'
          ? '上游未能完成搜索，详情见上方说明和引擎观察。'
          : '暂无符合条件的结果。',
      ),
    )
    return
  }
  state.results.forEach((result, index) => {
    const article = element('article', `result${result === state.selected ? ' selected' : ''}`)
    const source = sourceLine(result.source_metadata, result.url)
    source.append(element('span', 'result-number', String(index + 1).padStart(2, '0')))
    const title = button(
      result.title || result.url,
      () => selectResult(result, true),
      'result-title',
    )
    title.setAttribute('aria-pressed', String(result === state.selected))
    title.setAttribute('aria-label', `${result.title || result.url}，查看原文证据`)
    const badges = element('div', 'badges')
    badges.append(
      element('span', 'badge', `词法相关性 ${percent(result.relevance?.score)}`),
      element('span', 'badge', `溯源 ${label(result.confidence?.level)}`),
      element(
        'span',
        `badge${result.evidence_status === 'verified' ? '' : ' warn'}`,
        `${array(result.evidence).length} 段原文 · ${label(result.evidence_status)}`,
      ),
    )
    const actions = element('div', 'result-actions')
    actions.append(
      button('检查证据 →', () => selectResult(result, true)),
      link('打开网站 ↗', result.url),
    )
    article.append(
      source,
      title,
      element('p', 'snippet', result.snippet || '上游未提供摘要。'),
      badges,
      element('p', 'ranking-note', rankingNote(result)),
      actions,
    )
    container.append(article)
  })
}

function appendWarnings(container, warnings) {
  if (!warnings.length) return
  const list = element('ul', 'warning-list')
  warnings.forEach((warning) => list.append(element('li', '', string(warning))))
  container.append(list)
}

function metadataDetails(metadata = {}, result) {
  const details = element('details')
  details.append(element('summary', '', '来源声明与字段溯源'))
  const fields = element('dl')
  const entries = [
    ['实际 URL', metadata.final_url || result.url],
    ['原始 URL', metadata.source_url],
    ['canonical', metadata.canonical_url],
    ['站点名称', metadata.site_name],
    ['元数据来源', metadata.metadata_source],
    ['抓取时间', timestamp(metadata.retrieved_at)],
    ['发布时间', timestamp(metadata.published_at)],
    ['favicon', metadata.favicon_url],
    ['logo', metadata.logo_url],
    ['预览图', metadata.image_url],
  ]
  for (const [name, value] of entries) {
    fields.append(element('dt', '', name))
    const description = element('dd')
    description.append(
      safeUrl(value) ? link(value, value) : document.createTextNode(value || '未提供'),
    )
    fields.append(description)
  }
  details.append(
    fields,
    element(
      'p',
      'small',
      '图标及 logo 为网站声明或 URL 后备，未下载验证；站点名称和 canonical 不构成身份认证。',
    ),
    element('pre', '', JSON.stringify(metadata.provenance || {}, null, 2)),
  )
  return details
}

function quoteBlock(evidence, index) {
  const block = element('section', 'quote-block')
  const labelRow = element('div', 'quote-label')
  labelRow.append(
    element('span', '', `原文 ${String(index + 1).padStart(2, '0')}`),
    element(
      'span',
      '',
      evidence.verification === 'exact_match' ? '快照精确匹配' : string(evidence.verification),
    ),
  )
  block.append(
    labelRow,
    element('blockquote', '', evidence.quote),
    element(
      'p',
      'quote-meta',
      `字符 ${evidence.start_char}–${evidence.end_char} · 抓取 ${timestamp(evidence.fetched_at)}`,
    ),
  )
  const detail = element('details')
  detail.append(
    element('summary', '', '定位与选段依据'),
    element(
      'pre',
      '',
      JSON.stringify(
        {
          snapshot_id: evidence.snapshot_id,
          content_sha256: evidence.content_sha256,
          segment_ids: evidence.segment_ids,
          expires_at: evidence.expires_at,
          relevance: evidence.relevance,
          selection_method: evidence.selection_method,
        },
        null,
        2,
      ),
    ),
  )
  block.append(detail)
  if (evidence.snapshot_cursor)
    block.append(
      button('读取这份完整快照 ↗', () =>
        read({ cursor: evidence.snapshot_cursor, format: 'text', max_chars: 12000 }, 'document'),
      ),
    )
  return block
}

function selectResult(result, focus) {
  state.readController?.abort()
  state.readVersion += 1
  state.activeRead = null
  state.selected = result
  renderResults()
  const panel = byId('evidence-panel')
  panel.replaceChildren(
    sourceLine(result.source_metadata, result.url),
    element('h3', 'source-heading', result.title || result.url),
  )
  panel.append(
    link(
      result.source_metadata?.display_url || result.url,
      result.source_metadata?.final_url || result.url,
    ),
    element(
      'p',
      'evidence-disclaimer',
      `词法相关性 ${percent(result.relevance?.score)} · 证据溯源等级：${label(result.confidence?.level)}。相关性反映查询匹配，溯源反映证据可追踪程度，两者都不是事实正确概率。`,
    ),
  )
  const rationale = element('details')
  rationale.append(
    element('summary', '', '相关性与置信度依据'),
    element(
      'pre',
      '',
      JSON.stringify(
        { relevance: result.relevance, confidence: result.confidence, ranking: result.ranking },
        null,
        2,
      ),
    ),
  )
  panel.append(
    element('p', 'ranking-note', rankingNote(result)),
    element(
      'p',
      'small',
      result.ranking
        ? '得分为 BM25 词法分，不是概率；BM25 + MMR 的最终排序还考虑重复程度，显示的分数不包含这项惩罚。'
        : '上游顺序直接保留候选顺序，词法相关性供独立参考。',
    ),
    rationale,
  )
  appendWarnings(panel, array(result.warnings))
  const quotes = element('div')
  quotes.id = 'quotes'
  array(result.evidence).forEach((evidence, index) => quotes.append(quoteBlock(evidence, index)))
  if (!array(result.evidence).length)
    quotes.append(
      element(
        'p',
        'read-status',
        `暂无原文片段（${label(result.evidence_status)}）。搜索摘要来自上游，不能替代抓取的原文证据。`,
      ),
    )
  panel.append(quotes)
  const actions = element('div', 'panel-actions')
  if (result.next_evidence_cursor)
    actions.append(
      button(
        '更多相关原文 ↓',
        () =>
          read(
            { cursor: result.next_evidence_cursor, format: 'text', max_chars: 12000 },
            'evidence',
          ),
        'secondary',
      ),
    )
  if (!array(result.evidence).length)
    actions.append(
      button(
        '抓取网页原文 ↗',
        () =>
          read(
            {
              url: result.url,
              format: 'text',
              max_chars: 12000,
              engine: byId('fetch-engine').value,
            },
            'document',
          ),
        'secondary',
      ),
    )
  actions.append(button('来源 JSON', () => showJson('来源与证据 JSON', result)))
  panel.append(actions)
  const readArea = element('div')
  readArea.id = 'read-area'
  const readStatus = element('div', 'read-status')
  readStatus.id = 'read-status'
  readStatus.setAttribute('role', 'status')
  readStatus.setAttribute('aria-live', 'polite')
  panel.append(readStatus, readArea, metadataDetails(result.source_metadata, result))
  if (focus && window.matchMedia('(max-width: 700px)').matches) {
    panel.focus()
    panel.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
}

async function read(input, view, append = false) {
  state.readController?.abort()
  const controller = new AbortController()
  state.readController = controller
  const version = ++state.readVersion
  const status = byId('read-status')
  const area = byId('read-area')
  status.replaceChildren(
    document.createTextNode('正在读取原文… '),
    button('取消读取', () => controller.abort()),
  )
  try {
    const output = await api('/api/fetch', input, controller.signal)
    if (state.readVersion !== version) return
    status.textContent = issues(output).join('\n')
    if (output.status === 'error') return
    if (!append) area.replaceChildren()
    state.activeRead = output
    const actualView = output.view || view
    area.append(
      element(
        'h3',
        'quote-label',
        actualView === 'evidence' ? '更多相关原文 · 非连续全文' : '完整快照 · 当前文档分页',
      ),
    )
    if (actualView === 'evidence')
      array(output.evidence).forEach((evidence, index) => area.append(quoteBlock(evidence, index)))
    else area.append(element('div', 'document', output.content || '该页没有正文。'))
    area.append(
      element(
        'p',
        'quote-meta',
        `快照 ${output.snapshot_id} · 抓取 ${timestamp(output.fetched_at)}\nSHA-256 ${output.content_sha256 || '未提供'}`,
      ),
    )
    area.querySelector('[data-continuation]')?.remove()
    const next =
      actualView === 'evidence'
        ? output.next_evidence_cursor || output.next_cursor
        : output.next_cursor
    if (next) {
      const more = button(
        actualView === 'evidence' ? '继续相关原文 ↓' : '继续读取下一页 ↓',
        () => read({ cursor: next, format: 'text', max_chars: 12000 }, actualView, true),
        'secondary wide',
      )
      more.dataset.continuation = 'true'
      area.append(more)
    }
    area.append(button('本页响应 JSON', () => showJson('原文读取 JSON', output)))
    if (!status.textContent)
      status.textContent = `读取完成${next ? '，还有后续内容。' : '，本次视图已读完。'}`
  } catch (error) {
    if (state.readVersion === version)
      status.textContent =
        error.name === 'AbortError' ? '已取消原文读取。' : `原文读取失败：${error.message}`
  } finally {
    if (state.readController === controller) state.readController = null
  }
}

async function refreshStatus() {
  byId('refresh-status').disabled = true
  try {
    const output = await api('/api/status')
    byId('status-json').textContent = JSON.stringify(output, null, 2)
    if (output.crawl4ai)
      byId('crawl4ai-hint').textContent = output.crawl4ai.installed
        ? `Crawl4AI ${output.crawl4ai.version || ''} 已安装。动态读取执行网页 JavaScript，不调用 LLM；快照续读不重新出网。`
        : 'Crawl4AI 尚未安装，请在项目目录运行 pnpm crawl4ai:setup。静态读取仍可使用；动态读取不会绕过验证码或 robots。'
    byId('connection').textContent =
      output.search_configured === false ? '本地已连接 · 搜索未配置' : '本地服务已连接'
    byId('connection').classList.add('ready')
    const container = byId('engines')
    container.replaceChildren()
    for (const engine of array(output.engines)) {
      const row = element('div', 'engine-row')
      const status = engine.status || engine.state || 'unknown'
      row.append(
        element('strong', '', engine.engine || engine.name || engine.id || '未知引擎'),
        element(
          'span',
          `badge${['ok', 'ready', 'healthy'].includes(status) ? '' : ' warn'}`,
          engine.observation === 'no_error_reported' ? label('no_error_reported') : label(status),
        ),
      )
      const elapsed = engine.last_latency_ms ?? engine.latency_ms ?? engine.elapsed_ms
      if (elapsed != null) row.append(element('span', 'small', `${elapsed} ms`))
      const reason =
        engine.reason || engine.last_error?.message || engine.last_error || engine.message
      if (reason) row.append(element('span', 'engine-reason', label(reason)))
      if (engine.submitted_requests != null)
        row.append(
          element(
            'span',
            'small',
            `请求 ${engine.submitted_requests} · 失败 ${engine.failed_responses ?? '未知'}`,
          ),
        )
      if (engine.last_observed_at)
        row.append(
          element(
            'span',
            'engine-reason',
            `最近观察 ${timestamp(engine.last_observed_at)}${engine.elapsed_ms === null ? ' · 上游未提供单引擎耗时' : ''}`,
          ),
        )
      const until = engine.cooldown_until || engine.retry_at
      if (until) row.append(element('span', 'engine-reason', `可重试时间 ${timestamp(until)}`))
      container.append(row)
    }
    if (!container.children.length)
      container.append(
        element(
          'p',
          'small',
          output.search_configured === false
            ? '尚未配置 SearXNG。配置完成并重启工作台后可开始搜索。'
            : '尚无引擎观察记录。执行一次搜索后刷新。',
        ),
      )
  } catch (error) {
    byId('connection').textContent = '本地服务连接失败'
    byId('connection').classList.remove('ready')
    byId('engines').replaceChildren(element('p', 'small', error.message))
  } finally {
    byId('refresh-status').disabled = false
  }
}

async function refreshEvaluation() {
  byId('refresh-evaluation').disabled = true
  try {
    const output = await api('/api/evaluation')
    byId('evaluation-json').textContent = JSON.stringify(output, null, 2)
    const container = byId('evaluation')
    container.replaceChildren()
    if (output.available === false) {
      container.append(
        element(
          'p',
          'small',
          output.message || '暂无评估报告。运行评估后刷新此处；未运行不等于通过。',
        ),
      )
      return
    }
    const report = output.report || output
    container.append(
      element(
        'p',
        'small',
        `${report.mode || report.kind || '评估'} · ${timestamp(report.generated_at || report.created_at)}。离线回放不能证明上游当前可用。`,
      ),
    )
    const coverage = report.coverage || {}
    const metrics = element('div', 'metric-grid')
    for (const [name, value] of [
      ['查询目录', coverage.catalog_queries],
      ['已采集', coverage.recorded_queries],
      ['已标注', coverage.judged_queries],
    ]) {
      const metric = element('div')
      metric.append(
        element('span', 'metric-value', value ?? '—'),
        element('span', 'metric-label', name),
      )
      metrics.append(metric)
    }
    container.append(metrics)
    const table = element('table', 'evaluation-table')
    const caption = element('caption', 'sr-only', '相同候选池上的排序实验比较')
    const head = element('thead')
    const header = element('tr')
    for (const title of ['排序', 'nDCG@10', '池内 R@5', 'P95 毫秒']) {
      const cell = element('th', '', title)
      cell.scope = 'col'
      header.append(cell)
    }
    head.append(header)
    const body = element('tbody')
    for (const [mode, scores] of Object.entries(report.summary || {})) {
      if (!scores || typeof scores !== 'object') continue
      const row = element('tr')
      const name = element(
        'th',
        '',
        { upstream: '上游', bm25: 'BM25', bm25_mmr: 'BM25 + MMR' }[mode] || mode,
      )
      name.scope = 'row'
      row.append(name)
      for (const key of ['ndcg_at_10', 'pooled_recall_at_5', 'ranking_p95_ms'])
        row.append(
          element('td', '', typeof scores[key] === 'number' ? scores[key].toFixed(3) : '未测'),
        )
      body.append(row)
    }
    if (body.children.length) {
      table.append(caption, head, body)
      container.append(table)
    }
    container.append(
      element(
        'p',
        'small',
        '同池离线比较；池内 R@5 是前 5 条结果覆盖已标注相关候选的比例。缺少标签标为未测，Agent 标注不等于人工金标，池内召回率不代表全网召回率。',
      ),
    )
    appendWarnings(container, [...array(report.warnings), ...array(report.caveats)])
  } catch (error) {
    byId('evaluation').replaceChildren(element('p', 'small', `报告读取失败：${error.message}`))
  } finally {
    byId('refresh-evaluation').disabled = false
  }
}

byId('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  search().catch((error) => notice(error.message, true))
})
byId('cancel-button').addEventListener('click', () => state.searchController?.abort())
byId('more-results').addEventListener('click', () =>
  search(true).catch((error) => notice(error.message, true)),
)
byId('search-json').addEventListener('click', () => showJson('搜索响应 JSON', state.search))
byId('close-dialog').addEventListener('click', () => byId('json-dialog').close())
byId('refresh-status').addEventListener('click', refreshStatus)
byId('refresh-evaluation').addEventListener('click', refreshEvaluation)
document.querySelectorAll('[data-query]').forEach((node) =>
  node.addEventListener('click', () => {
    byId('query').value = node.dataset.query
    byId('sites').value = node.dataset.sites
    byId('query').focus()
  }),
)
window.addEventListener('pagehide', () => {
  state.searchController?.abort()
  state.readController?.abort()
})
await Promise.all([refreshStatus(), refreshEvaluation()])
