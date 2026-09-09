# 0.2.0 段落证据与前端字段验证

日期：2026-09-09。环境：macOS ARM64、Node 24.20.0、pnpm 10.12.3。实现决定见 [ADR 0005](../decisions/0005-paragraph-evidence-and-source-metadata.md)，字段说明见 [段落与前端展示](../13-evidence-presentation.md)。

## 真实搜索对照

查询保持为 `MCP tools structuredContent`，sites 限定 modelcontextprotocol.io，证据模式 extract。最终代码重新执行真实 MCP 调用，两份 Tools 文档分别返回：

| 来源 | 原策略首屏 | 新策略首屏 | 相关续读 |
| --- | --- | --- | --- |
| 2025-06-18 Tools | 276 字符 / 2 短片段 | 1,849 字符 / 3 段 | 所选内容已返回，不生成裸标题尾页 |
| 2026-07-28 Tools | 276 字符 / 2 短片段 | 2,732 字符 / 3 段 | 另有 3 页，总计 6,362 字符的相关原文 |

首屏包含 structuredContent 定义、兼容说明和 output schema 条件。quote 均保持原文连续子串，跨段 segment_ids、字符位置和完整正文 SHA-256 一致。相关续页逐页使用新 MCP 进程读取，元数据保持一致，没有重复原文范围，末页 cursor 正确结束。

这次响应为 partial，包含采集预算告警；目标网页的原文获取完成。不是全网穷尽或原文质量无缺陷的声明。

## 实际前端元数据

两份文档返回站名 Model Context Protocol，以及实际 HTML 声明的 favicon、JSON-LD logo、Open Graph 预览图、canonical 与语言。provenance 分别标记来源；assets_verified=false，没有下载或验证图标，也没有调用图标代理或 Key 服务。

无原文补抓的结果返回 url_only：站名来自 hostname，favicon 为明确标记的约定地址，logo/image 为 null。网页声明不能替代真实 hostname，也不能用 canonical 覆盖实际 URL。

## 自动化与打包

检查覆盖 strict 类型、类型感知 lint、格式、公共 Schema 与内联定义一致性、模块边界、源码行为、真实 MCP 入口和干净 tarball 安装。新增回归覆盖软换行完整句、稀有查询词、跨段定位、裸标题过滤、更多证据的重启/预算/过期、元数据提取与错误来源拒绝、非法日期、长 URL 和 Unicode 名称。

最终 pnpm check 通过：225 项离线行为测试、4 项真实 MCP 测试，合计 229 项；6 个 Schema/18 个示例、类型、类型感知 lint、格式、生成类型和模块边界检查通过。pnpm test:built 的干净安装、实际 MCP 入口与解析 worker 通过。

2026-07-28 Tools 的前后完整正文 SHA-256 相同，确认首屏从 276 到 2,732 字符的变化来自选段策略，不是页面正文变化。相关续读额外 3 页后共 6,362 字符，逐页重启验证通过。参数冲突提示也改为明确说明 sites 与 include_domains 不能同时提供，并经 MCP 回归验证。

## 保留的失败与限制

较早的完整 live-smoke 运行中，英文增强链路和相关证据续读成功，但中文步骤遇到 UPSTREAM_BLOCKED，脚本如实非零退出。未绕过验证码、使用付费服务或将失败改成空结果。最终再次验证的是本次改动的英文真实链路，不能声称中文当次也成功。

本机详细原文、元数据和前后对照保存在被 Git 忽略的 artifacts/paragraph-evidence-2026-09-09/report.md，原始失败保留为 first-live.json，最终响应为 final-search.json。图标可用性、全网站质量、PDF、动态浏览器和向量精排不在本次验证范围。
