# 站点与证据契约验证

本记录为实现前的历史文件检查；后续运行结果见 [实施验收](2026-09-08-implementation.md)。
日期：2026-09-08。范围：业务契约 0.2-draft、域限定、原文证据与可解释评分设计。当前仍无服务运行实现。

## 实际检查

- `node scripts/check-docs.mjs`：文件换行、JSON 语法与本地 Markdown 文件链接检查。
- `uv run --no-project --with jsonschema python -`：通过临时工具环境检查四个 Draft 2020-12 Schema，以及所有业务请求/响应构造示例。
- 内联断言核对 evidence 的 snapshot_id、完整文本 SHA-256、连续 quote、segment_id、Unicode code point offsets 和已取得证据的结果计数。
- 八个非法契约反例被拒绝：sites 与 include_domains 同时提供、sites 使用完整 URL、none 模式提供证据数量、超出证据数量上限、相关性大于 1、填写真假概率、verified 无原文、unavailable 携带原文。

最终检查通过：65 个文本文件、25 个 JSON、80 个本地文件链接；4 个 Schema、16 个示例，以及原文关联和预算耗尽错误分支的一致性断言。

## 独立只读复核

读者检查指出两处边界：分支失败且无结果如何表示，域过滤清空当前上游页如何处理续页。设计已统一为无结果的分支失败返回 error，以及先采集/过滤/冻结候选池再本地分页；未采集范围因预算停止且无结果时明确返回 SEARCH_BUDGET_EXHAUSTED，不伪造 empty 或未知上游 cursor。

修正后针对这两项的独立只读复核通过。

## 证据限制

例子全部为构造数据，评分版本带 illustrative。没有运行域匹配实现、真实搜索、提取器、评分器或快照服务；Schema 不负责证明 IDNA/PSL 规则、DNS 策略、事实真假或真实网页中的摘录。关联断言仅证明构造示例内部一致。临时校验依赖未安装为项目生产依赖。
