# MCP 工具契约

工具名按需求固定为 `websearch`、`webfetch`。服务名提供命名空间，不另注册多个同义工具。JSON Schema 位于 `schemas/`，默认值须由服务端显式应用，JSON Schema 的 default 本身不会填值。

当前业务输出版本为 0.3-draft，包含站点限定、原文证据与可解释评分；两个工具及全部构造响应同步使用该版本，本版本首次公开，后续变更按版本策略管理。

## MCP 与 SDK 边界

本次官方 README 指向 TypeScript SDK v2 稳定线，包拆分为 `@modelcontextprotocol/server` 和 `@modelcontextprotocol/client`，对应 2026-07-28 规范。[官方 SDK](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)

实际实现时锁定准确包版本，用 SDK 处理协议包装，不手写 JSON-RPC。v1 示例的 import 路径不能直接混入 v2。目标客户端的兼容性必须实测；若需要旧协议支持，使用明确兼容层和验证矩阵。先提供 stdio，日志仅 stderr；远程服务后续增加 Streamable HTTP。

声明 inputSchema/outputSchema；结果使用 structuredContent 并提供 text content 表示以适配客户端。结构化 JSON 文本兼容模式可序列化同一对象，避免不同字段表达相反状态；精简文字展示需评估不同客户端的呈现行为。当前 schema 表示业务对象，不是完整 MCP envelope。[Tools 规范源文件](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx)

建议 annotations：readOnlyHint=true、destructiveHint=false、openWorldHint=true；本地缓存不构成用户业务写入。idempotentHint=true 表示重试没有额外业务副作用，不保证动态网页多次返回内容完全相同。

## websearch

输入：query 必填，1–1,000 字符；limit 1–20，默认 8；language 默认 auto；time_range 为 any/day/month/year。sites 为允许域名清单，include_domains 为互斥同义输入；exclude_domains 为排除清单；include_subdomains 默认 true。域名、IDNA、排除优先和严格过滤语义由 [站点与证据设计](12-sites-evidence-scoring.md) 维护。

evidence_mode 默认 none；extract 时补抓前 max_evidence_results 条结果的原文证据，省略数量默认 3、最多 5。max_evidence_results 不能在 none 模式提供。段落数量、长度、总调用 deadline 均受部署配置限制，工具不能放宽。

cursor 为可选不透明续页标识，只读取首次调用已采集、过滤、去重并冻结的候选池。续页仍带原查询、规范化域范围和证据选项，服务端核对是否一致；不把未知上游页伪造为游标。应用层过滤后不足 limit 可少返回；没有缓存的剩余合格候选才返回 null。采集预算不足且无结果为 SEARCH_BUDGET_EXHAUSTED，有可用结果为 partial 并报告覆盖限制；empty 仅代表计划采集范围有效耗尽后的零结果。详见 [分页规则](12-sites-evidence-scoring.md)。

输出：schema_version、request_id、status（ok/partial/empty/error）、query、results、providers、scope、evidence_summary、warnings、next_cursor、error。scope 回显实际规范化筛选与执行策略；error 且无法解析范围时允许为 null。evidence_summary 记录模式、目标结果数与已取得证据的结果数。

每条结果保留 source_id、title、url、snippet、rank、providers、published_at，并增加 evidence_status、evidence、relevance、confidence 和 warnings。有已校验原文时 evidence_level=page_excerpt，否则为 search_snippet；snippet 始终是上游摘要。新增 source_metadata、evidence_chars、has_more_evidence 和 next_evidence_cursor；展示与续读语义见 [段落与展示](13-evidence-presentation.md)。confidence.scope 固定 evidence_traceability，fact_probability 必须 null。relevance 为解释查询匹配的分值，不是事实正确概率。

每个 evidence 有精确 quote、snapshot_id、text 格式、完整哈希、segment_id/segment_ids、selection_method、字符偏移、来源 URL、获取/过期时间、提取器版本与 snapshot_cursor；用 `webfetch({cursor: snapshot_cursor})` 可读取同一快照。关系校验、状态表和评分规则见 [设计](12-sites-evidence-scoring.md)，不能仅凭 Schema 合法就宣称证据真实。

rank 是本次冻结候选池内的全局名次，续页不从 1 重新编号；调试级上游 rank 独立存储，不能与业务排序混用。published_at 来自上游时需在未来扩展中保留 provenance。不能用搜索结果数量推断搜索成功。

## webfetch

输入为二选一：首次使用 url；续读使用 cursor。不同时接收两者。format 为 markdown/text；max_chars 默认 12,000、最大 50,000，单位为 Unicode code points。view=document 返回连续文档页；next_evidence_cursor 打开 view=evidence，返回非连续但精确引用的相关段落，不能把拼接 content 当整篇文档。

成功输出还包括 view、source_metadata、evidence、evidence_chars、has_more_evidence 和 next_evidence_cursor；完整字段：schema_version、request_id、status（ok/partial/error）、source_id、snapshot_id、url、final_url、title、fetched_at、content_type、content、content_sha256、segments、truncated、next_cursor、warnings、error。

快照绑定输出 format；续读省略 format 时继承 cursor 的格式，显式指定不同格式返回 CURSOR_MISMATCH。首次读取未给 format 才应用 markdown 默认值。request_id 标识本次工具调用，fetched_at 保留该快照实际获取时间，不因续读变成当前时间。

content_sha256 指完整规范化提取快照，不是本页片段；segments 含 id/text/start_char/end_char，对应完整快照内 Unicode code point 左闭右开偏移。展示时以结构边界分段，必要时拆长段，不能超过请求预算。游标必须覆盖剩余内容，不能重复或跳过。

document 视图的 truncated=true 表示本页结束后仍有快照内容待续读，必须附非空 next_cursor；正常分页时 status 仍可为 ok。末页即使不是从文档开头开始，也返回 truncated=false、next_cursor=null。partial 表示提取完整性或资源处理存在额外限制，必须有 warning，不能用 truncated 替代。下载超限返回 RESPONSE_TOO_LARGE，不把半份 HTML 当完整网页。不支持的 PDF/图片返回 UNSUPPORTED_CONTENT_TYPE。evidence 视图中 truncated/next_cursor 与 has_more_evidence/next_evidence_cursor 对应；max_chars 同时约束段落和拼接分隔符，完整段无法放入时明确报错。

## 错误与部分成功

| error.code | 含义 | retryable |
| --- | --- | --- |
| CONFIGURATION_REQUIRED | 未配置搜索后端 | false |
| INVALID_ARGUMENT | 结构合法但参数语义冲突、非法域范围或超出可用策略 | false |
| SEARCH_BUDGET_EXHAUSTED | 候选采集预算已耗尽，仍有未采集范围且无可用结果 | false，缩小范围后重新查询 |
| RATE_LIMITED | 上游限流 | true，附 retry_after_ms 如可得 |
| UPSTREAM_BLOCKED | 挑战页或拒绝自动请求 | false |
| UPSTREAM_UNAVAILABLE | 上游不可用 | true |
| HTTP_ERROR | 上游非成功 HTTP 状态，包含可选 http_status | 按状态判断，4xx 通常 false、可恢复 5xx 才 true |
| TIMEOUT | 达到 deadline | true |
| CANCELLED | 调用已取消 | false，不自动重试 |
| FETCH_BLOCKED | URL 不符合出网策略 | false |
| ROBOTS_DENIED | 本项目抓取策略拒绝 | false |
| UNSUPPORTED_CONTENT_TYPE | 当前媒体类型尚未支持 | false |
| RESPONSE_TOO_LARGE | 超出下载或解压预算 | false |
| EXTRACTION_FAILED | 未提取出有效正文 | false |
| CURSOR_EXPIRED | 快照或游标失效 | false，重新开始 |
| CURSOR_MISMATCH | 游标与查询/格式不匹配 | false |
| STORAGE_UNAVAILABLE | 快照无法读取或提交，包含容量不足 | false，先处理存储问题 |
| INTERNAL_ERROR | 未预期实现错误，已脱敏 | false |

错误对象含 code/message/retryable，可选 retry_after_ms 和 http_status。message 应给下一步操作，不泄露内部堆栈或密钥。工具执行失败使用 MCP isError=true 和业务 status=error；有用的部分结果 isError=false、status=partial；有效零命中 isError=false、status=empty。协议解析与未知工具错误交给 SDK。每个输出 schema 都容纳 error 形态，不要求失败时存在虚假的正文。

SDK 在已取消连接上可能不再允许发送工具结果；此时只记录请求取消终态并清理资源，不强行写响应。CANCELLED 用于仍可返回业务结果的取消路径，不把用户取消记成 TIMEOUT。

例子见 `examples/`，全部为构造数据，未证明任何上游实际响应。
