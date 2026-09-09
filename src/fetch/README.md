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
- 纯文本与 Markdown MIME 提取为原文；Markdown 输出将其按字面量转义，避免透传原始 HTML 或恶意引用链接。PDF、图片和浏览器动态渲染尚不支持。

`FetchOptions` 全部由装配根解析后传入：deadlineMs、maxCompressedBytes、maxDecompressedBytes、maxRedirects、globalConcurrency、perHostConcurrency、parserConcurrency、parserTimeoutMs、parserMemoryMb、userAgent。模块不读取环境变量、不在 import 时建立资源。

单元/网络验证位于 [fetch.spec.ts](../../tests/fetch.spec.ts)，元数据声明与恶意 URL 验证位于 [metadata.spec.ts](../../tests/metadata.spec.ts)。真实公网效果由独立 live smoke 验证，不与受控 fixture 测试混称。
