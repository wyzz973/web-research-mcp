const byId = (id) => document.getElementById(id)
const state = {
  runs: [],
  run: null,
  spans: [],
  selectedId: null,
  selectedStep: null,
  viewVersion: 0,
  viewController: null,
  operation: null,
  clientId: null,
  followClient: false,
  pollingUntil: 0,
  timer: null,
  polling: false,
  disposed: false,
  requests: new Set(),
}
const labels = {
  running: '进行中',
  ok: '完成',
  partial: '部分完成',
  error: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
  interrupted: '进程中断',
  healthy: '已观察可用',
  unknown: '尚未观察',
  cooling_down: '冷却中',
  cooldown: '冷却中',
  half_open: '恢复探测中',
  blocked: '需验证或受限',
  unavailable: '暂不可用',
  timeout: '超时',
  disabled: '未启用',
  no_error_reported: '未报告错误，未确认结果',
}
const guides = {
  'fetch.resolve': [
    '理解网页读取要求',
    '检查这次是读取一个公开网址，还是用游标继续读取已保存内容。',
    'webfetch 有两种入口：新抓取会访问网站，快照续读使用保存的数据。',
  ],
  'fetch.load': [
    '执行网页读取',
    '把网页地址交给受控抓取流程，等待网页正文和来源信息。',
    '这是父步骤，里面可能包含 DNS、robots、HTTP 和解析步骤；总耗时已经包含它们。',
  ],
  'fetch.read_evidence': [
    '继续读取相关原文',
    '使用证据游标读取同一份快照里预先选好的其他段落。',
    '它不是连续全文分页，不会为了回看证据重新搜索。',
  ],
  'fetch.redirect': [
    '网站要求跳转',
    '网站响应把请求指向另一个地址，服务记录并重新检查新目标。',
    '每一次跳转都必须重新符合域名和网络策略；不会自动信任目标。',
  ],
  'fetch.content_check': [
    '检查响应是否是可用内容',
    '判断 HTTP 状态、内容类型和挑战页特征，决定是否可以提取正文。',
    '返回一张验证码网页不是成功读取文章，不能继续当作原文证据。',
  ],
  'search.read_pool': [
    '读取固定搜索清单',
    '使用搜索游标从 SQLite 取回本次先前保存的候选网页。',
    '固定清单保持翻页一致性；过期后不能伪装成同一次搜索。',
  ],
  'search.cached_page': [
    '返回已保存的结果页',
    '本次直接复用先前保存的页面数据，没有为这一步重新出网。',
    '请查看已有观察的时间。复用旧记录不是一次新的网页抓取。',
  ],
  'search.branch_partial': [
    '记录一个分支未完成',
    '一个站点或页码的搜索没有完整完成，服务记录原因并评估可用结果。',
    '部分失败与没有结果不同；其他已成功分支仍可能提供有用网页。',
  ],
  'search.http_request': [
    '请求本机 SearXNG',
    '实际向操作者配置的 SearXNG 发出 HTTP 请求，SearXNG 再查询选定引擎。',
    '这里看到的是聚合服务请求。HTTP 成功与上游引擎成功不同，验证码和引擎故障要看响应观察步骤。',
  ],
  'search.engine_selection': [
    '选择当前可请求的引擎',
    '根据最近观察和冷却状态，选择本次实际请求的搜索引擎。',
    '冷却中的引擎会暂时跳过。选择成功只说明调度完成，不代表上游一定会返回结果。',
  ],
  'search.engine_response': [
    '观察引擎返回情况',
    '记录 SearXNG 返回的候选数量、引擎错误和最新观察状态。',
    '聚合接口没有提供的单引擎耗时保持未知。未报告错误也不一定证明引擎贡献了结果。',
  ],
  'search.engine_failure': [
    '记录上游请求失败',
    '本次搜索引擎请求无法提供正常结果，记录失败原因及观察状态。',
    '验证码、超时、全部引擎冷却等情况需要区别处理，不会作为正常零结果返回。',
  ],
  'evidence.no_match': [
    '正文中没有合适片段',
    '网页已经取得，但选段没有找到足够匹配本次问题的原文。',
    '能抓到网页不等于它能回答问题。保持无证据比拼出无关引用更准确。',
  ],
  'evidence.unavailable': [
    '这份原文暂时不可用',
    '候选网页未能成功转为可引用的原文证据。',
    '查看错误码；仍可保留搜索线索，但不能把摘要标成已经核验的原文。',
  ],
  'search.resolve': [
    '理解搜索要求',
    '把输入整理成明确的执行条件：搜索什么、限定哪些域名、最多花多少时间。',
    '像把订单填完整。参数错误会在这里被拒绝，避免无意义地请求上游。',
  ],
  'search.collect': [
    '收集候选网页',
    '在请求和时间预算内，让 SearXNG 查找可能有用的网页。',
    '这一步找到的是网页线索，还不是已读取、核验过的正文。',
  ],
  'search.provider_request': [
    '获取这一页搜索候选',
    '先检查缓存与请求调度，再按需调用 SearXNG，取得标题、链接和摘要。',
    '这个父步骤可能只读缓存，也可能等待共享请求。只有实际 HTTP 子步骤才代表出网；总耗时包含排队，不能当作单个引擎的耗时。',
  ],
  'search.filter_deduplicate': [
    '过滤域名与重复链接',
    '检查网页是否符合 sites 范围，并合并重复 URL。',
    '搜索引擎的 site: 提示不够可靠，所以服务会再次检查返回网址。',
  ],
  'search.rank': [
    '排列候选顺序',
    '采用本次指定的上游顺序、BM25 或 BM25 + 多样性策略。',
    'BM25 目前使用标题与摘要的词法匹配，不是 LLM 判断；分数不是事实正确概率。',
  ],
  'search.freeze': [
    '保存本次候选清单',
    '把候选网页存入 SQLite，让后续翻页沿用同一次搜索。',
    '像给搜索结果拍一张定格照片；翻页时不会悄悄换成新排名。',
  ],
  'search.page': [
    '取出当前一页',
    '按本次数量要求取出结果，并在需要时给出下一页游标。',
    '游标是继续读取保存清单的凭证，不是新的搜索关键词。',
  ],
  'search.cache_hit': [
    '复用已有搜索观察',
    '本次请求命中了可复用的已有候选数据。',
    '省去重复请求能降低上游压力；请在输出中检查数据时间，不把缓存误认为刚刚搜索。',
  ],
  'search.cache_miss': [
    '没有可复用的搜索观察',
    '短缓存中没有可复用的数据，接下来可能排队或共用正在执行的请求。',
    '缓存不存在、已过期或查询条件不同，都可能需要一次新搜索。',
  ],
  'search.coalesced': [
    '共用正在执行的查询',
    '相同查询已有请求在执行，本调用等待其结果。',
    '多个调用共用一次上游工作可以减少重复流量，但每个调用仍有自己的取消与预算。',
  ],
  'search.queued': [
    '进入查询调度队列',
    '记录这次请求进入队列的时间点，接下来等待可用的执行额度。',
    '这是瞬时事件，不表示等待时长。实际排队时间在“开始上游请求”的 wait_ms 中；等待超时会明确失败。',
  ],
  'search.upstream_start': [
    '调度开始调用适配器',
    '调度允许开始调用搜索适配器，wait_ms 是共享请求此前在队列等待的毫秒数。',
    '这不是 HTTP 已发出的证明：所有引擎冷却时可能在联网前拒绝。实际出网看“请求本机 SearXNG”子步骤。',
  ],
  'search.upstream_end': [
    '上游请求结束',
    '记录本次实际搜索请求结束的时间点，检查输出中的结果或错误。',
    '此事件本身没有请求持续时长。HTTP 返回成功也不保证有有效结果，上游挑战页仍应报告失败。',
  ],
  'evidence.skipped': [
    '本次不提取原文',
    '这次只返回搜索候选，或受执行条件限制跳过证据提取。',
    '搜索摘要不能冒充网页原文。需要证据时可以发起 webfetch。',
  ],
  'evidence.result': [
    '核验这一条搜索结果',
    '为这一条来源读取正文、保存快照并选择证据。展开子步骤就能看到它成功或失败的位置。',
    '不同来源可以并发处理，某一条没有证据不会抹去其他来源的成功结果。',
  ],
  'evidence.fetch': [
    '为结果读取网页',
    '对选中的候选访问原网站，以取得可引用的真实正文。',
    '通常只读前几条，避免为所有候选都访问网站。一个网页失败不一定使整次搜索失败。',
  ],
  'evidence.select': [
    '挑选相关原文段落',
    '在提取的正文中选择匹配问题、保留必要上下文的段落。',
    '选段是原文截取，不是 LLM 改写。相关性和事实真伪仍然是两件事。',
  ],
  'evidence.persist': [
    '保存证据定位',
    '记录原文段落、快照标识和字符位置，便于后续续读与核验。',
    '按给定位置从同一快照截取，应该得到同一段文字。',
  ],
  'fetch.validate': [
    '检查网址格式与域名范围',
    '检查 URL 语法、允许的协议和 sites 域名范围。此时还没有确认实际 IP 是否允许访问。',
    '这一步通过不表示目标已被证明是公网。真正的 IP 与私网访问检查在后续“确认实际连接地址”步骤中完成。',
  ],
  'fetch.dns': [
    '确认实际连接地址',
    '查询域名指向的 IP，并检查实际连接是否允许。',
    '域名像联系人名字，IP 像地址。看起来公开的网址也不能直接获准访问本机或内网。',
  ],
  'fetch.robots': [
    '检查网站抓取规则',
    '读取并解释 robots.txt，判断网站是否允许本服务读取该路径。',
    '网站不允许时会停止；不会为了找到结果忽略这一步。',
  ],
  'fetch.http': [
    '下载网页响应',
    '使用受控的 Node.js / Undici HTTP 请求读取网页。',
    '会检查跳转、响应类型、大小、超时和验证码。读取 HTML 不会自动执行网页 JavaScript。',
  ],
  'fetch.parse': [
    '从网页提取正文',
    '独立 worker 使用 JSDOM 与 Mozilla Readability 提取文章，Turndown 生成 Markdown。',
    '像从报纸上取出文章，尽量去掉菜单和广告。只有动态脚本才能显示的内容可能提取不到。',
  ],
  'fetch.snapshot': [
    '保存正文快照',
    '把这次提取的正文与来源元数据保存到 SQLite。',
    '快照和正文哈希帮助复核引用；它不是整个网站的永久备份。',
  ],
  'fetch.read_snapshot': [
    '读取已有正文快照',
    '按快照和游标继续读取先前保存的正文。',
    '这一步通常不重新访问原站。快照过期需要重新抓取，不能把新旧内容混成一份。',
  ],
  'fetch.present': [
    '整理工具返回值',
    '把正文、来源信息、快照和续读凭证整理为工具响应。',
    'LLM 收到结构化资料后才负责组织答案，本步骤不调用模型。',
  ],
}
// These named instrumentation points record an event, not an operation duration.
const eventNames = new Set([
  'search.queued',
  'search.upstream_start',
  'search.upstream_end',
  'search.cache_hit',
  'search.cache_miss',
  'search.coalesced',
  'search.cached_page',
  'search.branch_partial',
  'search.engine_selection',
  'search.engine_response',
  'search.engine_failure',
  'evidence.skipped',
  'evidence.no_match',
  'evidence.unavailable',
  'fetch.redirect',
])
const isEvent = (step) => step !== state.run && eventNames.has(step.name)
const stepDuration = (step) => (isEvent(step) ? '事件' : duration(step.duration_ms))
const array = (value) => (Array.isArray(value) ? value : [])
const label = (value) => (Object.hasOwn(labels, value) ? labels[value] : String(value ?? '未知'))
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const duration = (value) =>
  !finite(value)
    ? '未知'
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`
const time = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
    : '未知时间'
const text = (value) =>
  typeof value === 'string' ? value : value == null ? '未知' : JSON.stringify(value)
function element(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content != null) node.textContent = String(content)
  return node
}
function statusBadge(status) {
  return element('span', `badge ${Object.hasOwn(labels, status) ? status : ''}`, label(status))
}
function notice(message, error = false) {
  byId('notice').textContent = message
  byId('notice').hidden = !message
  byId('notice').classList.toggle('error', error)
}
async function api(path, { body, signal, clientId, capture } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  state.requests.add(controller)
  const timeout = setTimeout(() => controller.abort(), body ? 90000 : 10000)
  const headers = {
    'X-Workbench-Token': document.querySelector('meta[name="workbench-token"]')?.content || '',
  }
  if (body) headers['Content-Type'] = 'application/json'
  if (clientId) headers['X-Trace-Request'] = clientId
  if (capture !== undefined) headers['X-Trace-Content'] = String(capture)
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const output = await response.json()
    if (!response.ok)
      throw new Error(
        `${output?.error?.code || `HTTP ${response.status}`} · ${output?.error?.message || '本地请求失败'}`,
      )
    return output
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    state.requests.delete(controller)
  }
}
function preview(run) {
  const input = run.input
  const value = input?.query ?? input?.url
  if (typeof value === 'string') return value
  if (value?.redacted) return `输入已隐藏${finite(value.chars) ? ` · ${value.chars} 字符` : ''}`
  return run.tool === 'webfetch' ? '读取网页或已有快照' : '搜索调用'
}
function renderRuns() {
  byId('run-count').textContent = String(state.runs.length)
  const container = byId('runs')
  container.replaceChildren()
  if (!state.runs.length) {
    container.append(element('p', 'empty', '还没有运行记录。\n提交上方表单，观察第一次调用。'))
    return
  }
  for (const run of state.runs) {
    const row = element('button', 'run-row')
    row.type = 'button'
    row.dataset.runId = run.id
    row.setAttribute('aria-pressed', String(run.id === state.selectedId))
    const top = element('div', 'run-top')
    top.append(element('strong', '', run.tool || '未知工具'), statusBadge(run.status))
    const bottom = element('div', 'run-bottom')
    bottom.append(
      element('span', '', time(run.started_at)),
      element('span', '', duration(run.duration_ms)),
    )
    row.append(top, element('p', 'run-title', preview(run)), bottom)
    row.title = `${preview(run)}\n${run.id}`
    row.addEventListener('click', () => {
      state.followClient = false
      handle(selectRun(run.id))
    })
    container.append(row)
  }
}
function guide(step) {
  if (step === state.run)
    return [
      '一次完整工具调用',
      '你或 LLM 发起的这次调用，从接收输入到整理响应。下面的步骤是它实际记录的工作。',
      '总耗时包含子步骤；并行或嵌套步骤的耗时不能简单相加。本服务没有模型推理步骤，不记录虚构的 token 或费用。',
    ]
  return (
    (Object.hasOwn(guides, step.name) ? guides[step.name] : null) || [
      step.name || '未命名步骤',
      '这是服务实际记录的一个执行步骤。查看下方输入、输出与状态，了解其实际工作。',
      '此步骤尚无专门的入门解释；不会用猜测补齐未记录的信息。',
    ]
  )
}
function orderedSteps() {
  const children = new Map()
  for (const span of state.spans) {
    const key = span.parent_id || null
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(span)
  }
  const result = []
  const seen = new Set()
  function append(span, depth) {
    if (seen.has(span.id)) return
    seen.add(span.id)
    result.push({ step: span, depth: Math.min(depth, 6) })
    for (const child of children.get(span.id) || []) append(child, depth + 1)
  }
  for (const span of children.get(null) || []) append(span, 0)
  for (const span of state.spans) if (!seen.has(span.id)) append(span, 0)
  return result
}
function allSteps() {
  return state.run ? [state.run, ...orderedSteps().map((entry) => entry.step)] : []
}
function waterfall(step) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 116 26')
  svg.setAttribute('class', `waterfall ${Object.hasOwn(labels, step.status) ? step.status : ''}`)
  svg.setAttribute('aria-hidden', 'true')
  const rootStart = Date.parse(state.run.started_at)
  const start = Date.parse(step.started_at)
  const observedEnd = Math.max(
    rootStart,
    ...state.spans
      .map(
        (span) => Date.parse(span.started_at) + (finite(span.duration_ms) ? span.duration_ms : 0),
      )
      .filter(Number.isFinite),
  )
  const total = finite(state.run.duration_ms) ? state.run.duration_ms : observedEnd - rootStart
  function rect(x, width, className) {
    const node = document.createElementNS(svg.namespaceURI, 'rect')
    for (const [key, value] of Object.entries({
      x,
      y: 9,
      width,
      height: 7,
      rx: 2,
      class: className,
    }))
      node.setAttribute(key, String(value))
    return node
  }
  svg.append(rect(0, 116, 'track'))
  if (Number.isFinite(start) && Number.isFinite(rootStart) && Number.isFinite(total) && total > 0) {
    const x = Math.max(0, Math.min(112, ((start - rootStart) / total) * 116))
    const width = finite(step.duration_ms)
      ? Math.max(2, Math.min(116 - x, (step.duration_ms / total) * 116))
      : 2
    svg.append(rect(x, width, 'bar'))
  }
  return svg
}
function renderSummary() {
  const run = state.run
  if (!run) return
  const container = byId('run-summary')
  container.replaceChildren()
  const name = element('div', 'summary-name')
  name.append(element('strong', '', run.tool), statusBadge(run.status))
  const metrics = element('div', 'metrics')
  const resultCount = array(run.output?.results).length
  for (const [title, value] of [
    ['总耗时', duration(run.duration_ms)],
    ['已记录步骤', state.spans.length],
    [
      run.tool === 'webfetch' ? '返回字符' : '返回结果',
      run.tool === 'webfetch'
        ? (run.output?.content_chars ?? '未知')
        : Array.isArray(run.output?.results)
          ? resultCount
          : (run.output?.result_count ?? '未知'),
    ],
    ['模型调用', '服务内无模型'],
  ]) {
    const metric = element('div', 'metric')
    metric.append(element('span', '', title), element('strong', '', value))
    metrics.append(metric)
  }
  container.append(
    name,
    metrics,
    element(
      'p',
      'capture-note',
      `${run.capture_content ? '本次记录了有界内容预览；敏感字段仍会脱敏。' : '本次仅记录元数据；查询与正文可能已隐藏。'}${run.truncated ? ' 记录达到上限，部分内容或步骤被截断。' : ''}`,
    ),
  )
}
function renderSteps() {
  const container = byId('steps')
  container.replaceChildren()
  if (!state.run) return
  const entries = [{ step: state.run, depth: 0 }, ...orderedSteps()]
  entries.forEach(({ step, depth }, index) => {
    const row = element('button', `step-row step-depth-${depth}`)
    row.type = 'button'
    row.dataset.stepId = step.id
    row.setAttribute('aria-pressed', String(step.id === state.selectedStep))
    const name = element('span', 'step-name')
    name.append(
      element(
        'strong',
        '',
        `${index === 0 ? '◎' : `${String(index).padStart(2, '0')} ${depth ? '↳ ' : ''}`}${guide(step)[0]}`,
      ),
      element(
        'span',
        'step-caption',
        `${label(step.status)} · ${step === state.run ? step.tool : step.name}`,
      ),
    )
    row.append(name, waterfall(step), element('span', 'step-duration', stepDuration(step)))
    row.addEventListener('click', () => chooseStep(step.id))
    container.append(row)
  })
  updatePlayback()
}
function updatePlayback() {
  const steps = allSteps()
  const index = steps.findIndex((step) => step.id === state.selectedStep)
  byId('step-position').textContent = `${index < 0 ? 0 : index + 1} / ${steps.length}`
  byId('previous-step').disabled = index <= 0
  byId('next-step').disabled = index < 0 || index >= steps.length - 1
}
function recovery(step) {
  if (!['error', 'partial', 'cancelled', 'interrupted'].includes(step.status)) return null
  const value = text(step.output)
  if (/CAPTCHA|UPSTREAM_BLOCKED|captcha/i.test(value))
    return '上游要求人机验证或限制自动访问。保留可用引擎结果，等待冷却后再试；不要反复点击搜索。冷却不会保证解除验证码。'
  if (/ROBOTS|robots/i.test(value) && ['error', 'partial'].includes(step.status))
    return '网站抓取规则限制了读取。选择允许抓取的其他公开来源；搜索摘要不能替代原文证据。'
  if (/TIMEOUT|timeout/i.test(value))
    return '这一步超出了时间预算。先检查是否已有可用的部分结果，再减少抓取数量或稍后重试。'
  if (/INVALID_ARGUMENT/i.test(value))
    return '检查输入参数。sites 填域名，webfetch 填完整的公开 HTTP(S) 网页地址。'
  if (step.status === 'cancelled')
    return '请求已取消。已记录的步骤仍可回看；如果需要再次出网，请显式重新运行。'
  if (step.status === 'interrupted')
    return '记录显示运行进程中断，不能认定调用已成功。检查服务是否运行，再决定是否重新提交。'
  if (step.status === 'error')
    return '检查下面输出中的错误码和发生错误的子步骤。修正原因后再提交；回看本记录不会重试。'
  if (step.status === 'partial')
    return '本次只有部分工作完成。检查具体失败的子步骤，区分“搜索返回了结果”和“原文成功取得”。'
  return null
}
function renderDetail() {
  const step = allSteps().find((item) => item.id === state.selectedStep)
  if (!step) return
  const container = byId('step-detail')
  const body = element('div', 'detail-body')
  const [title, explanation, analogy] = guide(step)
  body.append(
    statusBadge(step.status),
    element('h3', 'detail-lead', title),
    element('p', 'detail-code', `${step === state.run ? step.tool : step.name} · ${step.id}`),
  )
  if (byId('tutorial').checked) {
    const teaching = element('div', 'teaching')
    teaching.append(
      element('strong', '', '用一句话理解'),
      element('p', '', explanation),
      element('p', 'small', analogy),
    )
    body.append(teaching)
  }
  const facts = element('dl', 'fact-grid')
  const timing = isEvent(step)
    ? [
        ['记录类型', '瞬时事件（不是阶段耗时）'],
        ['发生时间', step.started_at || '未知'],
      ]
    : [
        ['开始', step.started_at || '未知'],
        ['结束', step.ended_at || (step.status === 'running' ? '仍在执行，尚未结算' : '未记录')],
        ['耗时', duration(step.duration_ms)],
      ]
  if (step.name === 'search.upstream_start')
    timing.push(['实际排队等待', duration(step.output?.wait_ms)])
  for (const [key, value] of [
    ...timing,
    ['父步骤', step === state.run ? '完整调用（根）' : step.parent_id || '完整调用'],
    ['状态', label(step.status)],
  ])
    facts.append(element('dt', '', key), element('dd', '', value))
  body.append(facts)
  const advice = recovery(step)
  if (advice) body.append(element('div', 'recovery', advice))
  for (const [titleText, value] of [
    ['输入 · 传入这一步的数据', step.input],
    ['输出 · 这一步返回的数据', step.output],
  ]) {
    const details = element('details', 'detail-json')
    details.open = true
    details.append(
      element('summary', '', titleText),
      element(
        'pre',
        '',
        value === undefined
          ? step.status === 'running'
            ? '尚未返回输出。'
            : '未记录。'
          : JSON.stringify(value, null, 2),
      ),
    )
    body.append(details)
  }
  body.append(
    element(
      'p',
      'small',
      'redacted 表示已隐藏；truncated 表示只保留有界预览。这里显示记录内容，不执行其中的代码或网页。',
    ),
  )
  container.replaceChildren(body)
}
function chooseStep(id) {
  state.selectedStep = id
  for (const row of byId('steps').querySelectorAll('[data-step-id]'))
    row.setAttribute('aria-pressed', String(row.dataset.stepId === id))
  updatePlayback()
  renderDetail()
}
async function loadDetail(id, version, signal) {
  const output = await api(`/api/traces/${encodeURIComponent(id)}`, { signal })
  if (state.disposed || version !== state.viewVersion || state.selectedId !== id) return
  const run = output.run
  if (!run || run.id !== id) throw new Error('运行记录格式不符合预期。')
  state.run = run
  state.spans = array(output.spans ?? run.spans).filter(
    (span) => span && typeof span.id === 'string',
  )
  if (!allSteps().some((step) => step.id === state.selectedStep)) state.selectedStep = run.id
  renderSummary()
  renderSteps()
  renderDetail()
  byId('poll-state').textContent =
    run.status === 'running' ? '正在读取实际记录' : '已结束 · 只读回看'
}
async function selectRun(id) {
  state.viewController?.abort()
  state.viewController = new AbortController()
  const version = ++state.viewVersion
  state.selectedId = id
  state.selectedStep = null
  state.run = null
  state.spans = []
  renderRuns()
  byId('run-summary').replaceChildren(element('p', 'empty', '正在读取这次运行…'))
  byId('steps').replaceChildren()
  byId('step-detail').replaceChildren(element('p', 'empty', '正在读取步骤详情…'))
  await loadDetail(id, version, state.viewController.signal)
  if (version === state.viewVersion && state.run?.status === 'running') {
    state.pollingUntil = Date.now() + 120000
    schedulePoll()
  }
}
async function refreshRuns() {
  const output = await api('/api/traces')
  if (state.disposed) return
  if (!Array.isArray(output.runs)) throw new Error('运行列表格式不符合预期。')
  state.runs = output.runs.filter((run) => run && typeof run.id === 'string')
  renderRuns()
  const followed =
    state.followClient && state.runs.find((run) => run.client_request_id === state.clientId)
  if (followed && followed.id !== state.selectedId) await selectRun(followed.id)
}
async function refreshStatus() {
  const output = await api('/api/status')
  if (state.disposed) return
  byId('connection').textContent =
    output.search_configured === false ? '本地已连接 · 搜索未配置' : '本地服务已连接'
  const container = byId('engines')
  container.replaceChildren()
  for (const engine of array(output.engines)) {
    const row = element('div', 'engine-row')
    row.append(
      element('strong', '', engine.engine || engine.name || engine.id || '未知引擎'),
      document.createTextNode(' '),
      statusBadge(
        engine.observation === 'no_error_reported'
          ? engine.observation
          : engine.status || engine.state || 'unknown',
      ),
    )
    if (engine.reason || engine.last_error || engine.message)
      row.append(element('p', '', text(engine.reason || engine.last_error || engine.message)))
    if (engine.cooldown_until || engine.retry_at)
      row.append(element('p', '', `可重试时间 ${text(engine.cooldown_until || engine.retry_at)}`))
    container.append(row)
  }
  if (!container.children.length)
    container.append(element('p', 'small', '尚无引擎观察。未观察不等于可用。'))
}
function needsPoll() {
  return (
    !state.disposed &&
    (state.operation || state.run?.status === 'running') &&
    Date.now() < state.pollingUntil
  )
}
function schedulePoll() {
  if (state.timer || state.polling || !needsPoll()) return
  state.timer = setTimeout(() => {
    state.timer = null
    handle(poll())
  }, 1000)
}
async function poll() {
  state.polling = true
  try {
    await refreshRuns()
    if (state.selectedId)
      await loadDetail(state.selectedId, state.viewVersion, state.viewController?.signal)
  } catch (error) {
    if (error.name !== 'AbortError' && !state.disposed)
      byId('poll-state').textContent = `读取失败 · ${error.message}`
  } finally {
    state.polling = false
    if (needsPoll()) schedulePoll()
    else if (!state.disposed && (state.operation || state.run?.status === 'running'))
      byId('poll-state').textContent = '自动观察已到 2 分钟上限，请手动刷新'
  }
}
function formInput() {
  const mode = byId('trace-mode').value
  const query = byId('trace-query').value.trim()
  if (!query) throw new Error('请先填写搜索问题或公开网页 URL。')
  if (mode === 'fetch') {
    const url = new URL(query)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('请填写不含用户名、密码的 HTTP(S) 网页地址。')
    return { mode, body: { url: url.href, format: 'text', max_chars: 8000 } }
  }
  const sites = [
    ...new Set(
      byId('trace-sites')
        .value.split(/[\s,，]+/u)
        .filter(Boolean),
    ),
  ]
  const extract = byId('trace-evidence').checked
  return {
    mode,
    body: {
      query,
      limit: Number(byId('trace-limit').value),
      ranking_mode: byId('trace-ranking').value,
      evidence_mode: extract ? 'extract' : 'none',
      ...(sites.length ? { sites } : {}),
      ...(extract ? { max_evidence_results: 3 } : {}),
    },
  }
}
async function submit() {
  const { mode, body } = formInput()
  state.operation?.abort()
  const controller = new AbortController()
  state.operation = controller
  state.clientId = crypto.randomUUID()
  state.followClient = true
  state.pollingUntil = Date.now() + 120000
  byId('cancel-run').hidden = false
  byId('run-button').textContent = '取消旧调用并重新运行 ↗'
  notice('正在执行真实调用。记录到达后会展示步骤；页面不预测执行进度。')
  schedulePoll()
  try {
    const output = await api(`/api/${mode}`, {
      body,
      signal: controller.signal,
      clientId: state.clientId,
      capture: byId('trace-content').checked,
    })
    if (state.operation !== controller || state.disposed) return
    await refreshRuns()
    if (state.followClient && typeof output.trace_id === 'string') await selectRun(output.trace_id)
    if (state.operation !== controller || state.disposed) return
    notice(
      `本次调用：${label(output.status)}。${output.trace_id ? '点击步骤查看实际输入与输出。' : '响应未关联运行记录；请检查服务是否启用可观测记录。'}`,
      ['error', 'partial'].includes(output.status),
    )
    await refreshStatus()
  } catch (error) {
    if (state.operation !== controller || state.disposed) return
    notice(
      controller.signal.aborted
        ? '已取消本次调用。取消前记录的步骤仍可回看。'
        : `调用未完成：${error.message}`,
      true,
    )
  } finally {
    if (state.operation === controller) {
      state.operation = null
      byId('cancel-run').hidden = true
      byId('run-button').textContent = '运行并观察 ↗'
      schedulePoll()
    }
  }
}
function handle(promise) {
  promise.catch((error) => {
    if (!state.disposed && error.name !== 'AbortError') notice(error.message, true)
  })
}
byId('trace-form').addEventListener('submit', (event) => {
  event.preventDefault()
  handle(submit())
})
byId('cancel-run').addEventListener('click', () => state.operation?.abort())
byId('refresh-runs').addEventListener('click', () =>
  handle(
    (async () => {
      await refreshRuns()
      if (state.selectedId) await selectRun(state.selectedId)
      else if (state.runs[0]) await selectRun(state.runs[0].id)
      await refreshStatus()
    })(),
  ),
)
byId('previous-step').addEventListener('click', () => {
  const steps = allSteps()
  const index = steps.findIndex((step) => step.id === state.selectedStep)
  if (index > 0) chooseStep(steps[index - 1].id)
})
byId('next-step').addEventListener('click', () => {
  const steps = allSteps()
  const index = steps.findIndex((step) => step.id === state.selectedStep)
  if (index >= 0 && index + 1 < steps.length) chooseStep(steps[index + 1].id)
})
byId('tutorial').addEventListener('change', renderDetail)
byId('guide-toggle').addEventListener('click', () => {
  const hidden = !byId('flow-guide').hidden
  byId('flow-guide').hidden = hidden
  byId('guide-toggle').setAttribute('aria-expanded', String(!hidden))
  byId('guide-toggle').textContent = hidden ? '展开流程说明' : '收起流程说明'
})
byId('trace-mode').addEventListener('change', () => {
  const fetchMode = byId('trace-mode').value === 'fetch'
  document.querySelectorAll('.search-control').forEach((node) => {
    node.hidden = fetchMode
  })
  byId('trace-query').placeholder = fetchMode
    ? 'https://www.sqlite.org/wal.html'
    : '输入问题，观察每一步如何执行'
})
window.addEventListener('pagehide', () => {
  state.disposed = true
  if (state.timer) clearTimeout(state.timer)
  state.operation?.abort()
  state.viewController?.abort()
  for (const controller of state.requests) controller.abort()
})
const initialized = await Promise.allSettled([refreshRuns(), refreshStatus()])
for (const result of initialized)
  if (result.status === 'rejected')
    notice(`初始化失败：${result.reason?.message || '本地服务不可用'}`, true)
if (state.runs[0]) {
  try {
    await selectRun(state.runs[0].id)
  } catch (error) {
    notice(error.message, true)
  }
}
