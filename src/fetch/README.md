# 受控正文抓取

`createDocumentLoader(options, dependencies?)` 是公开装配入口，实现共享 `DocumentLoader`。所有资源在 `close()` 取消并等待结束。`dependencies` 只用于测试装配网络与 DNS 边界，不由用户配置或 MCP 参数提供。

- 普通 HTTP/HTTPS 默认端口；拒绝凭证、非公网 IP、混合公网/私网 DNS。每次连接固定到当次已验证 IP，保留原始 hostname 供 Host/TLS 校验。
- 每次跳转先检查 domain scope、协议降级、重定向次数，再验证 DNS；robots 请求走同一网络边界。
- 使用 robots-parser 3.0.1，缓存最多 256 个 origin、5 分钟。404/410 视为无规则，无法安全确定规则时拒绝抓取。支持 Allow/Disallow 和 Crawl-delay；429 记录有界 cooldown，当前请求明确失败，不隐式重试。
- 全局 load、每 hostname I/O 和解析 worker 分别采用可取消并发许可。解析器上限独立于网络并发；压缩体、解压体独立限制，超限不返回半份正文。
- HTML/XHTML 在有内存与时间上限的 worker 中执行 jsdom、Readability、Turndown/GFM。页面脚本与子资源不启用；所有 worker 终止后才结束请求。
- Readability 修改 DOM 前提取站点展示信息：站名、描述、语言、canonical、图标、JSON-LD Organization/WebSite logo、独立的 Open Graph 预览图及日期。相对声明按页面 baseURI 解析；source_url、final_url、metadata_url 保持实际请求和获取来源，不由 canonical 改写。
- 元数据声明是未验证的页面数据。图标无声明时给出明确标记的 origin/favicon.ico 后备；logo 不用预览图代替。资源 URL 仅接受无凭证 HTTP(S)，剔除本机域名和非公网 IP 字面量，允许外域 CDN；不解析 DNS、不下载资源，assets_verified 恒为 false。前端必须按文本渲染站名等字段，不能注入 HTML；未来服务端代理资源仍需完整网络验证。
- JSON-LD 最多处理 20 个 script，每个 64,000 字符、累计 256,000 字符，遍历最多 2,000 个节点、16 层；非法可选声明被忽略，不能让正文提取失败。元数据文本和 URL 分别受契约长度限制；纯文本/Markdown 仅给 URL 后备信息和实际抓取时间。
- logo 只接受顶层或 @graph 的站点/组织声明，以及 Article、WebPage、WebSite 的显式 publisher；忽略 mentions/about 等无关嵌套对象。声明带 url/@id 时必须与实际页面同源；依次优先 WebSite、显式 publisher、Organization，同级按文档顺序。无法明确识别的归属返回 null，不解析外部 JSON-LD 引用。
- DOM 最多 50,000 个元素、深度 512。正文 HTML 中非 HTTP(S) 链接被移除；代码、标题、普通表格保留。未提取到正文返回 EXTRACTION_FAILED，挑战页返回 UPSTREAM_BLOCKED。
- 纯文本与 Markdown MIME 提取为原文；Markdown 输出将其按字面量转义，避免透传原始 HTML 或恶意引用链接。静态路径不执行网页 JavaScript；动态渲染由独立 Crawl4AI 路径提供。PDF 和图片正文提取尚不支持。

`FetchOptions` 全部由装配根解析后传入：deadlineMs、maxCompressedBytes、maxDecompressedBytes、maxRedirects、globalConcurrency、perHostConcurrency、parserConcurrency、parserTimeoutMs、parserMemoryMb、userAgent。模块不读取环境变量、不在 import 时建立资源。

单元/网络验证位于 [fetch.spec.ts](../../tests/fetch.spec.ts)，元数据声明与恶意 URL 验证位于 [metadata.spec.ts](../../tests/metadata.spec.ts)。真实公网效果由独立 live smoke 验证，不与受控 fixture 测试混称。

## Crawl4AI 浏览器资源边界

`createBrowserGateway(options, dependencies?, scope?, signal?)` 为一次浏览器渲染提供受控的匿名 GET 资源加载。`initialUrl` 固定最初协议；其余参数来自现有 `FetchOptions` 的网络预算。Crawl4AI/Chromium 的请求必须被拦截后交给该网关，不能通过 `route.continue` 直接出网。浏览器侧还必须拒绝非 GET、Service Worker、WebSocket 和未受控连接；网关不接收用户 Cookie、Authorization、自定义请求头或请求体。

主文档逐跳遵守调用者域名范围；iframe 文档拒绝。script、stylesheet、fetch、XHR 可以来自公共 CDN，但同样校验 URL、全部 DNS 答案、固定连接 IP、robots 和 HTTPS 降级。图片、字体、媒体及其他资源直接拒绝。机器人规则每 origin、每次渲染缓存并合并在途请求；robots 重定向也经过完整策略检查，无法建立规则时关闭访问。

一次渲染最多 60 次真实 HTTP 请求（含 robots），重定向最多 5 跳或部署设定的更小值；主文档上限 5 MiB，其他资源 2 MiB，解压后的合计上限 8 MiB，同时受部署字节预算约束。全局及每 hostname 有独立可取消并发许可，遵守 Crawl-delay 和当前渲染内的限流暂停。响应仅转交 MIME、缓存验证信息、有限 CORS 声明及验证后的 Location；不转交 Cookie、Content-Encoding、Content-Length 或任意响应头。

策略/网络失败抛出 `AppError`，由浏览器所有者对非必要子资源中止并记录部分加载警告；主导航失败必须让整个抓取失败。`close()` 取消并等待全部网关 I/O；`inspect()` 返回 requests、completed、blocked 和 decodedBytes。`crawl4ai.resource`、`crawl4ai.robots` 和 `crawl4ai.blocked` 使用现有 TraceRecorder 记录。网络安全与预算回归在 [browser-gateway.spec.ts](../../tests/browser-gateway.spec.ts)。

## 策略路由与桥接

`router.ts` 根据已解析的 static/crawl4ai/auto 选择实际 DocumentLoader。auto 只在静态提取失败或 HTML 可见文字少于 80 字符时尝试 Crawl4AI，不对阻止、robots、超时、大小或 MIME 拒绝进行后备。默认 static 保持原有轻量路径。

`crawl4ai.ts` 以私有 HOME 启动固定 Python worker，通过有界 NDJSON 请求/响应桥接 Node 网关。首次导航前 ready/continue 握手捕获验证过的进程组；stdout 按 UTF-8 流解码，取消传播到真实网络和 Python/Chromium。Crawl4AI 取得渲染后 HTML，再用既有 Readability/Turndown 规范化，以保留统一正文/Markdown/证据偏移；extractorVersion 和 fetchBackend 明确标记浏览器来源。它不是仅安装依赖，也不冒充静态抓取。

首次主文档与每次主重定向都经过网关；Playwright 对 fulfill 3xx 的隐式下一跳不会再次调用 route，所以 worker 拒绝隐式跳转并重新显式 arun。子资源 3xx 保守阻止并报告可能不完整。源页面 URL 取实际成功主响应，前端路由自行变更URL会附警告，不冒充另一个未取得的来源。
