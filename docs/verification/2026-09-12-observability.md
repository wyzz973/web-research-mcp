# 0.4.0 本地可观测与请求复用验收

日期：2026-09-12。环境：macOS ARM64、Node 24.20.0、pnpm 10.12.3；原生 SearXNG 18888，正式工作台 18900。用户此前要求的配置 Brave + DuckDuckGo 保持有效；Google 不在工作台当前引擎列表中。

## 实际交付

- `/trace`：中文流程导览、真实运行历史、嵌套步骤树与瀑布时间条、按步骤的解释/输入/输出/错误。支持运行中读取与只读逐步回看。
- MCP 和 HTTP 的相同业务函数均埋点；响应可选 trace_id，持久记录绑定真实 request_id。同一数据目录可查看独立 MCP 进程写入的记录。
- webfetch 可见 URL/DNS/robots/HTTP/内容检查/正文解析/快照/分页；按结果分组的证据流程保持并发父子关联。
- 完整成功 Provider 页缓存 60 秒、相同在途请求合并、至少 1 秒适配器启动间隔、最多 2 个并发。错误/部分失败页不缓存，原有引擎冷却仍生效。
- 数据本机 SQLite、限量与脱敏；默认 MCP 只记录元数据。观察页的内容预览选项明确可见，不上传托管 LangSmith。

## 自动化与打包

pnpm check 全部通过：328 项行为测试 + 4 项真实 MCP 入口测试，合计 332 项；类型、type-aware lint、格式、生成契约、Schema、边界和文档检查通过。

新增测试覆盖 trace 父子/并发/隐私/存储失败/字节与数量上限/跨进程读取/死进程中断；真实业务过滤排序证据与快照续读埋点；有内容和无内容采集选项/HTTP 认证/关联 ID；相同请求的共享、各订阅者取消、最后订阅者取消实际 I/O、排队 deadline、关闭等待；Trace 页面真实 JS/DOM 的迟到请求、实时关联、纯文本注入、事件语义和不出网回看。

pnpm test:built 通过：干净 tarball 安装后启动 MCP/worker/SQLite；实际打包 trace 页面、受保护的 trace API、private URL 拒绝及真实 fetch.dns 失败步骤都通过。MCP 回归从另一只读 SQLite 连接读取活跃 stdio 进程产生的已完成记录，核对 trace_id/request_id 和默认查询脱敏。

UI 最后针对“返回字符”标签再执行新旧页面 14 项 DOM 测试，全部通过。

## 真实浏览器与网络

没有用模拟响应替代下列观测：

| 场景 | 观察 |
| --- | --- |
| 临时 18901 初次搜索 | MCP tools structuredContent，限定官方域，返回 5 条；目标原文 2/3；保留 partial，62 个实际步骤 |
| 正式 18900 搜索 | SQLite SQLITE_BUSY，限定 sqlite.org，返回 3 条；目标原文 3/3；7.20 秒、65 个步骤，整体仍因引擎/覆盖限制为 partial |
| 运行中读取 | 正式搜索尚未完成时页面显示“正在读取实际记录”，已有 9 个步骤按钮；结束后关联同一 trace_id |
| webfetch 静态网页 | 读取 SQLite FTS5 官方文档成功，返回 8,000 字符，13 个实际步骤，保留正文续读信息 |
| 私网拒绝 | webfetch http://127.0.0.1/ 返回 FETCH_BLOCKED，在 fetch.dns 停止，4 个实际步骤；没有生成下载/解析成功步骤 |
| 下载中取消 | Python asyncio 文档的下载处于进行中时点击取消；1.83 秒结束，9 个步骤，root=cancelled，最终无 running 子步骤 |
| 逐步回看 | 点击下一步、下一步、上一步，记录到的 POST /api/search 或 /api/fetch 数量为 0 |
| 桌面/移动布局 | 1440 与 390 宽度的独立只读浏览器验证均无水平溢出，控制台无错误/警告；最终桌面截图再次确认结果计数与时间线 |

原文与完整运行记录保存在本机 ignored 的 artifacts/observability-2026-09-12。主要文件：final-search.json、final-search-trace.json、fetch.json、fetch-trace.json、blocked-trace.json、cancelled-trace.json、final-desktop.png、trace-ui-mobile.png，以及各项检查日志。它们含用户选择记录的有界内容，不进入公开 Git。

## 真实缓存验证

为单独验证缓存，在隔离数据目录中显式使用 Brave-only 配置，正式工作台仍为 Brave + DuckDuckGo。相同 query/sites/page 的两次请求均返回 3 条结果；受控 Provider 调用累计从 1 保持为 1，第二次 cache_hits 从 0 增至 1，记录出现 search.cache_hit 而没有再次调用上游。

该实验将候选采集限制为一页，因此工具整体保留预算 partial；可缓存的是这一份 errors=[] 的完整 Provider 页。不能把“工具因覆盖预算 partial”与“Provider 某引擎失败的 partial 页”混为一谈。证据见 cache-proof.json。旧探针字段 upstream_requests 在最终接口改为更准确的 provider_calls：适配器可能因全引擎冷却在实际 HTTP 前失败，不能把调用次数一律当出网次数；实际 HTTP 由 search.http_request 步骤证明。

## 发现并修复的观测问题

- 根输出过大时整体截断会失去结果数量：根节点改用有界摘要，数量/证据计数保留；原工具响应不变。
- 搜索部分结果的父步骤曾显示 ok：现在按真实分支 errors/warnings 显式 partial。
- webfetch 的 async span 返回需 await 才能继续由工具边界统一处理错误，已修复并有回归。
- 瞬时队列事件不能显示为“等待 0 ms”：UI 明确标事件，并从启动记录展示实际 wait_ms。
- 适配器调用、缓存命中与实际 HTTP 请求分开，不画成全部已联网。

## 限制

参考的是 LangSmith 的观察方式，不是它的托管服务；没有模型思维过程、token 计费或真假概率。免费引擎仍可能全部 CAPTCHA/限流，不承诺 SLA。缓存/调度按进程隔离，尚无跨进程统一出站配额；partial 页不缓存，未实现 stale-on-error。记录只保留有界预览与最近窗口；旧调用未开启观测时不能补录。PID 复用时保守保持 running，不猜测另一个活跃进程已死。

当前应先利用此页面观察真实失败和延迟，再决定是否扩展统一调度、带明确采集时间的部分结果缓存、查询预算分层或补召回策略。功能可用与免费上游持续可用必须分别判断。
