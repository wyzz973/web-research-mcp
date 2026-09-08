# ranking

第一版提供可解释词法相关性与原文证据选择；保留上游顺序，不自动按本地分数重排。

- [lexical.ts](lexical.ts)：`scoreRelevance(query, text, basis, language)` 使用 NFKC、统一小写、Intl.Segmenter 和唯一查询词覆盖率；移除内联 `site:` 控制词。版本记录规则、Node、ICU 和 locale。无可评分词返回 null，存在文本但零匹配返回 0；分数不是事实正确概率。
- [passages.ts](passages.ts)：`selectPassages(query, snapshot, { maxPassages, maxChars, language })` 返回连续、互不重叠的原文片段与 Unicode code point 偏移。匹配句子优先带前句和后句上下文，每段不超过 maxChars。无法容纳的超长完整句不截成可能丢失否定的证据；因此长无标点文本可能 no_match。
- 每段 quote 取自快照原文，候选按词法分数和原始位置稳定排序；没有匹配时不拿开头补齐。模块不抓取网络、不管理存储，也不生成事实置信分数。

URL 去重与域范围归 [domain-scope.ts](../shared/domain-scope.ts)；回归测试见 [ranking.spec.ts](../../tests/ranking.spec.ts)。
