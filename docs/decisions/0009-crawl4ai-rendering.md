# ADR 0009：受控 Crawl4AI 动态渲染

状态：接受。日期：2026-09-12。

## 决定

按用户要求接入真实 Crawl4AI AsyncWebCrawler.arun，而非仅安装依赖。使用固定 0.9.3/Python 3.12.11/Playwright 1.62.0，隔离 venv 与浏览器缓存，无 Docker、账号或 Key。默认保留静态方式；显式 crawl4ai 与有界 auto 经 FetchRouter 选择。搜索证据也可选择 fetch_engine，持久快照保留实际 backend。

浏览器执行不可信页面 JS，因此仅主 URL 的公网校验不够。每个浏览器 HTTP 请求必须被路由到 Node Broker，由现有 DNS 固定连接、robots、跳转、字节/数量/并发/截止时间策略执行。主页面严格保持用户 scope；CDN 脚本/样式/GET API 可以跨域但同样只允许公网匿名读取。拒绝 POST、iframe、WebSocket、Service Worker、下载与媒体。Python socket.connect 审计禁止自身互联网连接；Chromium 使用拒绝所有流量的本地代理作为漏拦截兜底，关闭非代理 WebRTC/QUIC。保留 Chromium sandbox 和 TLS 验证，不使用隐身伪装或验证码绕过。

Crawl4AI 上游默认启动参数含关闭 sandbox/忽略证书等设置，因此固定版本下局部替换 BrowserManager 的启动/上下文创建参数，仍由原 AsyncWebCrawler 执行渲染。版本升级必须重新审阅这段适配。参见 [官方 hooks](https://docs.crawl4ai.com/complete-sdk-reference/) 和 [参数说明](https://docs.crawl4ai.com/api/parameters/)。

Playwright fulfill(302) 的下一跳可能不再经过 route，实际测试中已由拒绝代理拦住。合法主重定向采用 abort 后显式新 arun，Node 每跳校验；不把最终网页字节填到旧 origin。子资源重定向暂保守拒绝并保留 partial 警告。

首次导航前 ready/continue 握手确认 Python 与独立 Chromium 进程组的父链、组 leader 和出生时间。取消/关闭只清理验证过的自有组，TERM 后必要时 KILL，并等待消失；不按端口或陌生 PID 盲杀。macOS/Linux 需要 /bin/ps；Windows 尚未支持。浏览器工作目录为私有临时 HOME，不读取用户浏览器档案。

Crawl4AI 渲染 HTML 后，继续用现有 Readability/Turndown 规范化，以保持统一安全文本、Markdown 与 Unicode 段落定位；Crawl4AI 原始 Markdown 不直接透传。本次未启用 LLM extraction、递归爬站、PDF、登录或任意执行脚本参数。

## 验证边界

真实 Chromium + Node fixture 网关验证 JS/GET数据生成正文、主302最终身份、私网拒绝、POST未出网、快照续读及无限循环脚本取消；fixture不冒充真实互联网。独立真实公开动态网页通过 MCP 验证。安装、网关、进程所有权、路由与 UI 的确定性回归以及 Linux Chromium CI 单独执行。
