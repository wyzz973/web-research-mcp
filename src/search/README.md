# search

搜索 Provider 与 SearXNG 适配，入口为 [searxng.ts](searxng.ts)。

- `createSearxngProvider({ baseUrl, engines, timeoutMs })` 实现共享 `SearchProvider`；所有请求只访问部署者配置的端点，不发现公共实例、不跟随跳转、不传递凭据或 Cookie。
- 固定准入名称为 `duckduckgo`、`bing`、`google`、`brave`、`mojeek`，指 SearXNG 的匿名网页适配器。部署者仍须保证实例内这些名称没有被改绑到其他适配器。
- `engines` 每次明确发送，同时省略 `categories`：SearXNG 会把显式分类中的引擎合并到 engines，从而扩大实际搜索范围。`query` 中以 `!`、`:` 开头的控制词以及 `<数字` 超时控制被拒绝；普通文本和 `site:` 保留。站点分支添加单个 `site:`，应用层仍须调用 `matchesScope` 严格过滤结果。
- JSON 响应限制 2 MiB，候选限制 200 条。正常零条才是 exhausted；有结果并伴随引擎错误保留 errors，零结果与引擎失败同时发生则抛领域错误。
- SearXNG 是受信任基础设施端点，可使用 loopback；此客户端与任意网页的公网抓取策略不同。固定目标、禁止跳转、响应限制和在途请求取消集中在 Provider 内，`close()` 取消并等待自有请求。

查询控制语义核查于 2026-09-08：[官方查询说明](https://docs.searxng.org/user/search-syntax.html)、[解析器源码](https://github.com/searxng/searxng/blob/master/searx/query.py)。接口与错误回归测试见 [search-searxng.spec.ts](../../tests/search-searxng.spec.ts)。真实引擎可用性必须另行执行 live smoke，本模块模拟测试不构成上游可用性证明。

## 引擎诊断与有界恢复

`createSearxngProvider` 返回兼容 `SearchProvider` 的 `SearxngProvider`，额外提供同步、只读、无出网的 `inspect()`。状态只归属于当前 Provider 实例；重启或每次运行 CLI 会创建新观察窗口，不声称跨进程统计。长期运行的 MCP/验收服务复用同一实例，`close()` 取消其请求。

诊断不保留查询、网页正文或上游原始异常串。顶层 `status` 为 idle/ready/degraded/unavailable/closed；`endpoint` 记录请求次数、失败次数、最近整体请求耗时和错误码。`engines` 逐项提供引擎名、unknown/healthy/cooling_down/half_open、最近错误码、SearXNG `suspended` 标志、累计失败响应数、连续失败数、提交请求数、本地冷却截止与剩余毫秒、半开探测是否在途。`elapsed_ms` 固定 null：SearXNG 聚合 JSON 没有逐引擎耗时，整体延迟不会被复制给各引擎。

`observation=results` 表示该引擎返回了候选；`no_error_reported` 仅表示完整的 `unresponsive_engines` 数组没有报告它失败，不证明引擎已索引目标站点。没有该数组且没有结果的引擎维持 unknown。HTTP 错误、连接超时或非法 JSON 属于端点失败，不会被伪装为每个引擎各失败一次。

仅校验通过的 SearXNG `unresponsive_engines` 二元或三元组更新引擎失败：CAPTCHA/429/forbidden 归 blocked，timeout 归 TIMEOUT，其余为 unavailable；第三项如果存在必须是 boolean。固定版本源码的第三项只是 `suspended`，不提供剩余暂停时间。blocked 或显式 suspended 的本地初次冷却为 300 秒，其他失败为 30 秒；连续失败指数增加，单次最多 30 分钟。状态基于时间计算，不启用后台重试定时器。

冷却期间请求明确省略该引擎，其余引擎继续搜索，并在页面 errors 中声明跳过原因；没有有效结果且任何引擎失败/被跳过时返回错误，不冒充 empty。冷却到期只允许一个请求纳入该引擎半开探测，后续请求暂时跳过它。上游仍报告暂停时重新冷却；正常结果或明确无错误响应恢复。取消/端点错误释放探测所有权但不伪造恢复。不会修改 SearXNG 缓存、清除封禁、替换身份、绕过验证码或转向未经准入的引擎。并发旧响应不能覆盖更新的引擎观察。

构建后可以做一次显式出网诊断：

```sh
pnpm build
node scripts/search-doctor.mjs --config config/local.example.json --query "MCP tools" --language en
```

输出 scope=single_process_probe，包含查询结果状态/数量以及结构化诊断，不输出完整查询或候选内容。退出码 0 表示请求正常（可能正常零结果），1 表示失败，2 表示部分引擎降级。这个命令在新进程中运行，不读取长期 MCP 实例的内存健康状态，也不会删除上游暂停信息。回归覆盖见 [engine-health.spec.ts](../../tests/engine-health.spec.ts)。

## 降低重复出网：进程内缓存、合并与调度

[resilient.ts](resilient.ts) 的 `createResilientProvider(provider, options)` 装饰同一个 `SearchProvider`，并拥有其关闭职责。运行时显式装配后，同一个长期 MCP/工作台进程可复用成功搜索页：默认有效期 60 秒、最多 128 项，缓存键和序列化页面合计最多 8 MiB。键包含原始 query、language、timeRange、site 和 page，不合并不同语言、站点或分页，也不做语义近似缓存。命中后保留原上游顺序和内容，TTL 不随命中延长；缓存对象与每个调用者返回对象隔离。正常零结果可以缓存；errors 非空的部分页面、异常和取消结果都不缓存，不用过期内容掩盖故障。缓存不会声称当前引擎已经恢复。

相同的并发搜索页共用一次上游请求，各调用者仍有独立取消/总 deadline。一个调用者超时不取消其他人；最后一个订阅者退出才取消实际 I/O。排队也受原调用者信号约束，不为排队重置时限。默认实际请求启动间隔至少 1 秒、最多 2 个在途请求；待完成订阅者总数（包括合并订阅）最多 128，超过时返回可重试的 `UPSTREAM_UNAVAILABLE`。这些约束作用于一个 Provider 实例到 SearXNG 的请求，不表示 SearXNG 内部每个引擎各有 1 秒间隔，不构成上游可用性保证。

`inspect()` 返回独立的 request-policy 统计（命中、未命中、合并次数、适配器调用次数 provider_calls、缓存字节/项数、队列/在途数）；原 SearXNG `inspect()` 继续负责引擎观察。可选 `onEvent` 记录 cache_hit（含缓存年龄）、cache_miss、coalesced、queued、upstream_start（含排队时间）和 upstream_end（ok/partial/error/cancelled）。cache_miss 不等于已出网，upstream_start 表示适配器调用开始，真正的 HTTP 由 search.http_request 步骤证明；coalesced 不新增上游调用。事件不含查询和 URL，绑定各订阅者的异步上下文，方便本地轨迹关联。遥测回调异常只增加 observer_errors，不改变搜索结果。

`close()` 停止接收、清理排队计时器、拒绝所有订阅并取消实际请求，然后等待被装饰 Provider 关闭与在途任务结束。缓存和统计仅在本进程有效，重启或单次 CLI 会重新开始，未实现跨进程请求合并或缓存，也不修改 SearXNG 暂停状态。行为测试见 [search-resilient.spec.ts](../../tests/search-resilient.spec.ts)，覆盖受控异步 I/O、独立取消、排队 deadline、并发/间隔、关闭等待、TTL/容量和轨迹上下文；不把这些测试当作真实免费引擎的可用性证明。
