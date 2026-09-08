# 受控正文抓取

`createDocumentLoader(options, dependencies?)` 是公开装配入口，实现共享 `DocumentLoader`。所有资源在 `close()` 取消并等待结束。`dependencies` 只用于测试装配网络与 DNS 边界，不由用户配置或 MCP 参数提供。

- 普通 HTTP/HTTPS 默认端口；拒绝凭证、非公网 IP、混合公网/私网 DNS。每次连接固定到当次已验证 IP，保留原始 hostname 供 Host/TLS 校验。
- 每次跳转先检查 domain scope、协议降级、重定向次数，再验证 DNS；robots 请求走同一网络边界。
- 使用 robots-parser 3.0.1，缓存最多 256 个 origin、5 分钟。404/410 视为无规则，无法安全确定规则时拒绝抓取。支持 Allow/Disallow 和 Crawl-delay；429 记录有界 cooldown，当前请求明确失败，不隐式重试。
- 全局 load、每 hostname I/O 和解析 worker 分别采用可取消并发许可。解析器上限独立于网络并发；压缩体、解压体独立限制，超限不返回半份正文。
- HTML/XHTML 在有内存与时间上限的 worker 中执行 jsdom、Readability、Turndown/GFM。页面脚本与子资源不启用；所有 worker 终止后才结束请求。
- DOM 最多 50,000 个元素、深度 512。正文 HTML 中非 HTTP(S) 链接被移除；代码、标题、普通表格保留。未提取到正文返回 EXTRACTION_FAILED，挑战页返回 UPSTREAM_BLOCKED。
- 纯文本与 Markdown MIME 提取为原文；Markdown 输出将其按字面量转义，避免透传原始 HTML 或恶意引用链接。PDF、图片和浏览器动态渲染尚不支持。

`FetchOptions` 全部由装配根解析后传入：deadlineMs、maxCompressedBytes、maxDecompressedBytes、maxRedirects、globalConcurrency、perHostConcurrency、parserConcurrency、parserTimeoutMs、parserMemoryMb、userAgent。模块不读取环境变量、不在 import 时建立资源。

单元/网络验证位于 [fetch.spec.ts](../../tests/fetch.spec.ts)。真实公网效果由独立 live smoke 验证，不与受控 fixture 测试混称。
