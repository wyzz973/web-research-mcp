# ADR 0008：本地可观测与搜索请求复用

状态：接受。日期：2026-09-12。

## 背景

MCP 面向 LLM，调用方需要区分搜索摘要、正文证据、上游失败与预算限制；维护者需要理解一次查询在哪个步骤耗时或失败。只有最终结果和日志不能解释整条链路。免费的匿名搜索也需要减少重复请求，但不能把旧错误隐藏成正常结果。

## 决定

借鉴 [LangSmith 的 trace/run 概念](https://docs.langchain.com/langsmith/observability-concepts)，在本机实现每次工具调用的运行记录和嵌套步骤，提供 `/trace` 页面。没有接入托管 LangSmith、其账号或 SDK，不发送第三方遥测，也不添加任何搜索 Key。它是执行观测，不是 LLM 思维过程；本服务没有模型调用、token 计费或事实正确率观测。

`src/shared/trace.ts` 定义 TraceRecorder/TraceStore 和显式注入的 AsyncLocalStorage 上下文。根调用 run 独立随机 ID，响应 optional trace_id 指向该记录；request_id 与实际工具响应关联。span 对应实际执行的异步阶段，event 对应真实发生的瞬时事件。取消与 partial 不转换成 ok；未运行的步骤不生成模拟进度。并发来源的证据流程有各自父节点。

`src/storage/traces.ts` 使用 storage.directory 下独立 traces.sqlite（schema v1），与正文快照生命周期分开；仍以 SQLite 为持久化机制。保留最近 100 次/24 小时，单次最多 200 步/256 KiB，单个输入输出预览最多 2,000 字符。SQLite 设置页数量上限与 WAL 检查点；默认 4 KiB 页对应 64 MiB 主文件上限。可观测写失败不改变工具结果，状态接口报告 storage_unavailable。进程被确认不存在时，未完成记录标 interrupted；不根据任意时长猜测仍在运行的其他进程已死，PID 复用的保守限制保留。

默认 observability.enabled=true、capture_content=false。MCP 默认仅记录运行元数据；操作者可通过配置启用有界内容预览。观察页面明确显示“记录查询与正文预览（仅本机）”，每次请求由同源认证头覆盖采集选项。headers、token、Cookie、口令、搜索 Key、游标等始终屏蔽；URL 去掉查询、fragment 和用户凭据。trace 不是完整原文归档；完整证据仍读取受控快照。

HTTP 新增受同一会话/Host/Origin 校验保护的 GET /api/traces 与 GET /api/traces/:id。X-Trace-Request 是仅用于匹配的客户端随机 UUID，不能指定或覆盖服务端 trace ID。页面每秒串行读取在途运行，回看上一/下一步只读已记录数据，不重发搜索。

`src/search/resilient.ts` 包装既有 Provider，提供 60 秒完整成功页缓存、相同在途请求合并，以及至少 1 秒启动间隔/最多 2 个实际并发请求。缓存最多 128 条/8 MiB，待完成订阅者最多 128。Key 包含原始查询、域分支、语言、时间范围与页码。部分失败/错误不缓存；正常零结果可以短暂缓存。取消一个订阅者不影响其他订阅者，全部订阅者取消才终止共享实际 I/O；close 等待清理。各订阅者的调度事件绑定各自 trace 上下文。

## 取舍与边界

缓存和引擎健康都是 Provider 实例内状态。多个独立 MCP 进程仍有独立缓存/节流，不声称已经实现跨进程统一出站配额。trace 持久化支持同一数据目录中不同 MCP 进程的可见性，两种共享边界不可混淆。

不缓存 partial 意味着部分引擎长期受限时缓存命中率较低，这是防止隐藏失败的保守第一版。后续可研究显式标注采集时间/部分失败的缓存与 stale-on-error，但须先扩展 LLM 输出契约。当前不会伪装过期结果、轮换身份绕过 CAPTCHA 或删除 SearXNG 的暂停缓存。

参考 [SearXNG 出站设置](https://docs.searxng.org/admin/settings/settings_outgoing.html)：盲目增加并发、超时和重试会增加延迟或上游负载，不能承诺匿名引擎永久可用。本次首先增加可测性、复用与受控请求，后续优化应以实际成功率、错误类别、延迟和证据覆盖为依据。
