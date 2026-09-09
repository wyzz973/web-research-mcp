# ranking

第一版提供可解释词法相关性与原文证据选择；保留上游顺序，不自动按本地分数重排。

- [lexical.ts](lexical.ts)：`scoreRelevance(query, text, basis, language)` 使用 NFKC、统一小写、Intl.Segmenter 和唯一查询词覆盖率；移除内联 `site:` 控制词。版本记录规则、Node、ICU 和 locale。无可评分词返回 null，存在文本但零匹配返回 0；分数不是事实正确概率。
- [passages.ts](passages.ts)：`selectPassages(query, snapshot, { maxPassages, maxChars, language })` 优先选择完整段落，并保留相邻标题、条件、否定和解释；每条是连续原文，每段不超过 maxChars（Unicode code points）。过长段落退到完整句选择，软换行仅在句子边界分析时视为空格，quote 始终直接取原文。无法容纳的完整长句不截断，因此长无标点文本可能 no_match。
- 上下文最多向前一段、向后两段扩展；后续段落需要查询词或条件、指代、规范措辞线索，标题开启独立章节。候选窗口相邻或重叠且合并后不超上限时合并；最终证据互不重叠。该规则是局部词法启发式，不声明已理解段落语义。
- 候选按文档内查询词稀有程度、尚未覆盖的查询词与原文位置稳定选择，防止常见 MCP/tools 介绍挤掉 structuredContent 等特定细节。此优先级只影响选段；公开 relevance 仍调用原词法覆盖率函数，不能把内部优先级当概率。
- quote 的 start_char/end_char 与原快照精确对齐；segment_ids 列出所有覆盖段落，segment_id 保留第一个段落作为兼容字段。发现与快照不符的段落元数据时跳过，且不通过上下文跨过该缺口。
- maxPassages 只限制最终数量，不改变前缀顺序；调用方可取得有界候选池（如 32 段）后冻结并分页。每结果的页长、总字符预算与续读归工具编排管理。没有匹配时不拿开头补齐；只有标题、没有实际正文上下文的窗口不生成证据候选或额外分页。模块不抓取网络、不管理存储，也不生成事实置信分数。

URL 去重与域范围归 [domain-scope.ts](../shared/domain-scope.ts)；回归测试见 [ranking.spec.ts](../../tests/ranking.spec.ts)。
