# 站点限定、原文证据与评分

类型：设计参考。此页定义用户新增需求，配套字段见 [工具契约](04-tool-contracts.md) 与 schemas。站点限定、证据获取与词法/可追溯评分已实现，示例仍是构造数据。实际检查见 [实施验收](verification/2026-09-08-implementation.md)。

## 能力与调用

```json
{
  "query": "MCP tools structuredContent",
  "sites": ["modelcontextprotocol.io", "github.com"],
  "exclude_domains": ["gist.github.com"],
  "include_subdomains": true,
  "limit": 8,
  "evidence_mode": "extract",
  "max_evidence_results": 3
}
```

此例只表达请求：在允许的域名范围搜索，按已返回排名为最多三条结果补原文证据。分数不改变默认上游排名。未启用 evidence_mode=extract 的快速搜索不主动抓正文。

## sites 与域名规则

`sites` 是正向域名清单；已有 `include_domains` 是同义输入，两者不能同时提供，resolve 后统一为 sites。列表内部为 OR，所有排除条件随后生效。正向清单省略或为空表示不限定域；exclude_domains 排除优先。

`include_subdomains=true` 默认匹配 hostname 等于域名或以 `.` 加域名结尾；false 仅匹配精确 hostname。此开关同时用于正向和排除清单。example.com 不匹配 evil-example.com 或 example.com.evil.net。域名规范化为 IDNA ASCII、小写并移除末尾根点；支持用户输入国际化域名，去重发生在规范化之后。

输入只接受 DNS hostname，不接受 scheme、路径、端口、userinfo、通配符或 IP 地址；也不接受单标签和纯公共后缀作为站点。公网 URL 与 DNS 安全检查仍由网络策略执行，站点白名单不等于私网访问许可。纯公共后缀识别采用固定版本的 Public Suffix List 解析库，升级记录规则版本。

正向清单被排除项完整覆盖时，在出网前返回 INVALID_ARGUMENT。部分重叠只排除交集，不悄悄删除用户筛选。中文域名的外观相似不等于同一域名，不按显示文字做模糊匹配。

结构化 sites 是强约束。query 内的 `site:` 仅作为上游查询语法，不覆盖结构化筛选；只有 query 里写 site 而未给结构化字段时，scope.enforcement 不声称存在应用层域过滤，并返回提示建议使用 sites。query 中引擎选择、直达跳转等 SearXNG 控制语法不能扩大上游白名单，Provider 必须拒绝或安全编码这类控制输入。

SearXNG 官方说明，不同上游不一定理解同一查询语法。因此 Provider 先用经验证的 site 查询或原生参数缩小召回，再由应用层检查每个候选 hostname；不能只拼接字符串后就声称严格限定。[SearXNG Search API](https://docs.searxng.org/dev/search_api.html)、[查询语法](https://docs.searxng.org/user/search-syntax.html)

不支持可靠多站点 OR 的上游可拆分查询，单次工具调用共享总请求/时间预算。并非每个站点都能搜索成功；部分分支失败且有可用结果时报告 partial；分支失败且没有可用结果时报告 error，保留逐分支诊断，不能报告 empty。scope 记录规范化 sites、exclude_domains、include_subdomains、enforcement 和实际 upstream_mode。removed_count 只计算本次见到且因域过滤被移除的候选，不是全网排除总数。

首次调用先在部署配置的页数、请求数、候选数与 deadline 内形成候选池，再执行域过滤、去重、固定排名和本地分页。搜索 cursor 只读这份已冻结的池，不作为将来未知上游页的占位。处理某个上游页后全部结果被过滤且还有可继续采集的分支时，在剩余预算内继续采集，不直接输出 empty。

所有计划分支已有效执行且其当前可采集范围耗尽，仍无合格候选，才返回 empty/null；如果还有未采集范围却触及预算且没有可用结果，返回 SEARCH_BUDGET_EXHAUSTED/null。分支失败优先报告对应上游错误。已有合格候选但采集被预算截断时返回 partial 和明确覆盖警告；next_cursor 仅表示冻结池内还有合格候选，不保证上游已穷尽。默认采集预算：最多 4 次上游请求、每查询最多 2 页、最多 80 个原始候选，全部计入总 deadline。无法知道全网总量时不提供 total。

max_upstream_requests 计量本项目到搜索适配器端点的 HTTP 调用，包括重试；SearXNG 内部多引擎扇出另受已配置引擎清单限制，不能把一次聚合调用记成只有一次搜索引擎请求。采集不完整的标记和覆盖告警随冻结池保存，后续每页都保持 partial，即使该页证据完整。

证据获取逐跳执行同一域范围检查，最终 URL 也必须通过；越界跳转的目标不发请求。原结果仍保留，evidence_status=out_of_scope，附原因，不引用越界页面。用户另行独立调用 webfetch 时没有隐含的上一轮搜索范围；使用证据 snapshot_cursor 只读取已保存快照，不出网。

## 证据获取与原文定位

`evidence_mode` 为 none 或 extract，默认 none；max_evidence_results 仅在 extract 时有效，省略默认 3、最多 5，也受部署上限和当前结果数约束。每次返回页只处理该页前 N 条已通过域过滤、去重后的结果，不因某条失败无限补抓后面的网页。同一页响应保存后重读复用证据状态，续页只处理下一页，不重跑整个池。默认每条最多 3 段，每段最多 1,600 Unicode code points，合计最多 4,000；部署可在 Schema 上限内配置。更多相关段落通过 next_evidence_cursor 读取，完整规则见 [段落与展示](13-evidence-presentation.md)。

证据由与 webfetch 共用的安全网络/解析/存储链路产生。固定使用 text 格式快照，在实际提取文本中选择与 query 相关的连续片段，并保留：id、quote、最终 url、snapshot_id、完整 content_sha256、segment_id、start_char/end_char、fetched_at/expires_at、extractor_version 和 snapshot_cursor。snapshot_cursor 从这份文本快照开头读取；同一结果的多个片段可以共用它。

必须满足 `quote == snapshot_text[start_char:end_char]`，偏移为 Unicode code points 左闭右开。quote 不作改写、翻译、补字或段内插入省略号；不连续内容拆成多个 evidence 对象。这里的原文是“实际获取网页后保存的提取文本”，不是原始 HTML 字节，不能把 text offsets 冒充 HTML offsets。提取器仍可能损失布局，warnings 必须保留。

输出 evidence 不表示页面陈述一定为真。`verification=exact_match` 只表示片段与本次保存快照精确一致。snapshot_cursor、哈希、source/snapshot 关系和有效期要由运行时复核；JSON Schema 只能检查字段形态。过期读取返回 CURSOR_EXPIRED，不换一份网页继续读旧偏移。

snippet 永远保留为搜索引擎提供的摘要；evidence 中只允许真实 page_excerpt。没有任何查询相关片段时状态为 no_match，不为了填字段拿文档开头充数。

## 证据状态和总体状态

| evidence_status | 含义 | evidence / confidence |
| --- | --- | --- |
| not_requested | none 模式未要求抓取 | 空数组 / unknown |
| verified | 至少一个片段通过快照精确校验且可读取 | 非空 / high 或 medium |
| unavailable | 已安排但因网络、解析、存储或策略无法取得证据 | 空数组 / low |
| no_match | 正文已读取，但未找到查询相关片段 | 空数组 / low |
| skipped_budget | 未在前 N 条或达到总预算未处理 | 空数组 / unknown |
| out_of_scope | 证据跳转或最终 URL 越过指定域范围 | 空数组 / low |

extract 模式下，前 N 条中任一未 verified 则总体 partial，并说明原因；前 N 之外按设计 skipped_budget，不单独造成 partial。none 模式没有证据不算 partial。搜索本身失败、零命中和部分上游失败仍遵循原契约。

evidence_summary 记录 mode、target_results（计划前 N 条数）和 verified_results（实际成功结果数），不把片段数当结果数。有结果但证据未全部完成仍保留结果。请求取消遵循已有取消契约，不能因为留有 SERP 数据就把取消改成成功。

## 相关联程度：relevance

首先支持“结果与当前 query 的相关性”，不是页面之间的因果关系或事实互相印证。结果级及片段级 relevance 字段包含 score、method、version、basis、matched_terms 和 reasons。score 为 0–1 的可解释匹配分值或 null，绝不是百分比正确率。

初始方法 lexical_coverage_v1：从查询中去除已识别的 site 控制部分；对 query 与被评分文本使用相同的 Unicode NFKC、大小写和分词过程。使用固定 Node/ICU 版本的 Intl.Segmenter 按 language 分词，只保留 word-like token，按规范化 token 去重。`score = 匹配到的唯一 query token 数 / 唯一 query token 总数`。没有有效查询 token 或没有可评估文本时为 null、method=none；有文本但没有匹配为 0。

结果级 basis=title_snippet：对标题与摘要的 token 并集计算，所有返回结果保持同一依据；正文证据另有 basis=quote 的片段分数。不要将补抓成功结果改成另一种结果评分依据后与其他条目直接比较。版本必须包含规则、Node/ICU 和分词 locale；中文、版本号、代码错误码的质量需要单独评估。

更高阶段可以使用局部 BM25、embedding 或本地 reranker，切换时必须修改 method/version/basis 并写 ADR；初版 schema 只承诺 lexical_coverage_v1 和 none。上游 rank、RRF 名次融合与相关性评分不同，不能把 rank 倒数叫置信度。默认仍按上游排名返回，评分用于解释，不隐式启用神经模型。

## 置信度：confidence

第一版 confidence 的 scope 固定为 evidence_traceability，表达“证据的来源和定位是否可靠”，不表达“事实正确”。包含 level、method=traceability_v1、reasons 和 fact_probability=null。

- high：verified 片段均通过快照精确匹配，cursor 未过期，提取无质量告警，缓存未标 stale。
- medium：仍 verified 且可定位，但提取有质量告警或使用了明确标记的 stale 内容。
- low：extract 已安排但 unavailable/no_match/out_of_scope，没有可核对的原文支持。
- unknown：not_requested 或 skipped_budget，尚未评估。

fact_probability 必须为 null；不能用高相关性、域名白名单、多搜索引擎命中或复制转载数量填成“事实 95% 正确”。原文包含否定、引用他人观点或过时内容时，精确匹配仍不能证明查询命题成立。

未来若提供事实置信概率，需要明确待验证 claim、支持/反驳/不足关系、独立来源去重、人工标注的校准/留出集及校准误差评估，另开 ADR 和工具版本。这不是第一版通过 LLM 自报分数可以替代的步骤。模型原始分数不自然等于校准概率，相关研究见 [Guo 等，2017](https://proceedings.mlr.press/v70/guo17a.html)。

## 预算、缓存和验收

none 模式保留原搜索 deadline；extract 模式采用部署配置中的独立总 deadline，包含搜索、受控补抓、存储、片段选择和返回，不对每条重置总预算。默认目标 3 条、最大 5 条；默认每结果 4,000 字符使 5 个结果的 quote 总量最多约 20,000 字符，其他元数据和 SERP 摘要单独受输出预算控制。

搜索缓存与游标绑定规范化域范围、冻结的过滤后候选池、evidence 参数、词法评分版本和提取策略。续页只从冻结池读取，rank 为池内全局排名；上游不支持翻页时最多采集它已返回的一页，但若该页含超过 limit 的合格候选，仍可以本地分页。池内没有剩余候选才返回 next_cursor=null，并区分是否有采集范围警告。证据的 expires_at 不得超过所属正文快照保留期；搜索续页有效期也不能超过其已返回证据的最早有效期。

验收覆盖：域名边界和 IDNA、精确/子域、排除优先、强约束不可被 query 覆盖、跨域跳转不连接、部分 site 查询失败、摘要不冒充证据、原文 hash/offset/cursor、片段否定语境、null 与 0 分数区别、置信等级与状态一致、预算耗尽和无 Key 完整链路。
