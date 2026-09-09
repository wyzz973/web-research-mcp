# 构造示例

本目录 JSON 是业务参数/结果示例，不是实际网络响应，也不是完整 MCP envelope。示例 URL 使用 example.com；标识和哈希只是格式占位。

当前业务输出为 0.3-draft。websearch.sites.input.json 演示域范围与证据选项；websearch.evidence.output.json 和 evidence-partial 例子展示成功及越界跳转缺证据。webfetch.evidence-snapshot.output.json 保存对应构造原文，用于独立校验 quote、hash 和 offsets。示例评分版本含 illustrative，不是本机已运行的评分器版本。

schemas 的成功/失败约束与 examples 应保持一致。运行实现前不能把这些文件视为功能验收证据。

webfetch.first-page.output.json 与 webfetch.last-page.output.json 表示同一构造快照的两页；末页虽然只含后半段，仍为 truncated=false。两页共用完整快照的内容哈希，拼接可复核完整文本，偏移单位为 Unicode code points。

webfetch.more-evidence.input.json 与 webfetch.evidence-page.output.json 演示更多相关段落；source_metadata 含构造的网页声明与分字段来源，图片未下载。
