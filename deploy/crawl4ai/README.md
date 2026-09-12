# 原生 Crawl4AI 渲染器

类型：可选运行时安装指南。用于 `webfetch` 的 JavaScript 页面渲染，无需 Docker、搜索 API Key 或 LLM Key。业务默认值与使用入口见[工具契约](../../docs/04-tool-contracts.md)。

## 安装与维护

先安装项目要求的 Node 24、pnpm 和 uv，再从项目根目录运行：

```sh
node scripts/crawl4ai-setup.mjs
```

脚本安装隔离 Python 3.12.11、Crawl4AI 0.9.3、Playwright 1.62.0 及该版本配套 Chromium。支持 macOS/Linux；Chromium 在 Linux 上仍需要系统图形/沙箱运行库。缺失时安装会失败并提示检查，不自动执行 sudo，也不关闭沙箱。Windows 未验证。

全部运行时位于被 Git 忽略的 `.cache/crawl4ai/`：

| 路径                | 内容                                  |
| ------------------- | ------------------------------------- |
| `venv/`             | 独立 Python 及冻结依赖                |
| `browsers/`         | Playwright 管理的 Chromium 和配套组件 |
| `data/`             | Crawl4AI 私有运行数据                 |
| `installation.json` | 版本、平台及依赖锁指纹收据            |

重复执行会验证版本、导入依赖并真实启动一次 Chromium；运行时损坏时按锁文件修复。安装或修复前请停止在途渲染请求。不会修改系统 Python，不安装浏览器扩展，不连接你已登录的浏览器。

安装有互斥锁。正常失败、SIGINT/SIGTERM 会清理锁；若安装被 SIGKILL，先检查 `install.lock/owner.json` 对应进程确实结束，再删除这一安装锁并重试，不能删除仍运行的安装锁。

## 依赖版本依据

[source.json](source.json) 固定 Python/Crawl4AI/Playwright 版本；[requirements.lock](requirements.lock) 固定所有 Python 传递依赖和包哈希，安装只接受匹配哈希的 wheel。Playwright 包决定浏览器 revision，浏览器归 Playwright 的官方下载器管理；浏览器压缩包没有额外的项目 SHA-256 清单。

更新依赖需要重新生成锁文件并复验真实渲染、网络禁止目标与进程清理：

```sh
uv pip compile deploy/crawl4ai/requirements.in --universal --python-version 3.12 --generate-hashes --index-url https://pypi.org/simple --output-file deploy/crawl4ai/requirements.lock
```

Crawl4AI 上游基础依赖含模型客户端及 stealth 相关包，本项目不调用这些功能，不下载模型；没有配置 `LLMExtractionStrategy`、`magic`、模拟用户或验证码处理。依赖包存在不代表业务启用对应能力。

## 浏览器如何取得网页

每次抓取启动独立 Python 进程与新的匿名 Chromium 上下文，通过真实 `AsyncWebCrawler.arun()` 执行 JavaScript。没有持久 Cookie、登录信息或共享浏览器会话。

浏览器的每一个允许的 HTTP GET 都先被 Playwright route 截获，以 NDJSON 请求交给 Node。Node 执行现有 URL/DNS/robots/字节预算策略，再把响应字节交回浏览器；浏览器自己不直接下载。父进程另外提供一个拒绝转发的本地代理，覆盖浏览器未被 route 捕获的连接。

- 阻止 Service Worker、WebSocket、WebRTC、WebTransport、弹窗、下载和 POST。
- 图片、字体、媒体与子 frame 不加载；脚本、CSS、GET fetch/XHR 可以通过 Node 策略读取。
- 主文档跳转使用逐次显式导航，每一跳重新经过 Node 策略；子资源跳转保守阻止并报告，避免浏览器自动跟随时越过 route。
- Python 进程本身禁止 Internet socket connect，浏览器控制使用管道；附带模型依赖明确使用离线模式。
- 不转发浏览器 Cookie、Authorization 或页面提供的请求头；响应不设置 Cookie。
- 保留 Chromium 沙箱和 TLS 校验；移除上游默认关闭沙箱、忽略证书及隐藏自动化标记的参数。
- 输出受限的渲染 HTML/Markdown，由 Node 继续统一提取正文、保存快照和计算引用偏移。
- 超时、取消由父进程向整个自有进程组传播并等待退出；Python 自身也设置总截止时间。

这适用于公开、匿名、以 GET 加载正文的动态页面。依赖登录、POST API、交互点击、验证码或 iframe 正文的网站可能无法完整读取；不会为获取结果放宽网络策略。

## Worker 协议

[scripts/crawl4ai-worker.py](../../scripts/crawl4ai-worker.py) 的 stdout 只输出 NDJSON 协议，第三方普通日志抑制；错误信息不复制 URL 查询、页面正文或底层异常文本。stdin 首行为：

```json
{
  "url": "https://example.org/article",
  "deadline_ms": 30000,
  "wait_ms": 1000,
  "proxy_url": "http://127.0.0.1:40000"
}
```

`deadline_ms` 是该 worker 的最大总时限，父调用剩余预算可更早取消，单位毫秒；`wait_ms` 是 DOMContentLoaded 后等候动态内容的时间。代理地址是父进程创建的拒绝转发服务，不能指向任意外部代理。

浏览器启动、策略 hook 安装后先发送 `type=ready`；父进程登记自有浏览器进程组并回复 `type=continue`，随后才开始导航。

请求消息含 `type=request`、整数 `id`、`url`、`resource_type`、`main_frame` 和 `redirect_depth`。父回复同一 id 的 `type=response`，提供 `status`、`headers`、`body_base64`，或者 `error`。不使用 `route.continue()` 或 `route.fetch()` 绕过父进程。

最终 `type=result` 返回 `success` 和 HTML/Markdown，或者脱敏错误。响应正文上限由 Node 控制，worker 额外限制渲染 HTML 为 5 MiB。原文证据仍以最终保存的提取正文快照为准。
