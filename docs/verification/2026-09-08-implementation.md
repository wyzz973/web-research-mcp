# 0.1.0 实施验收记录

日期：2026-09-08。开发平台：macOS ARM64，实际 Node 24.20.0、pnpm 10.12.3。

已完成两个工具、域范围、原文证据、SQLite 持久化与构建入口；M3 的向量/神经排序及 M4 的 PDF/动态浏览器不属于本次实现。

## 验证分层

离线检查、构建产物、真实上游与 GitHub CI 分别记录，不相互替代。实时来源可能验证码、限流或零结果，实际受阻样本也保留在部署说明中。

| 实际检查 | 结果 |
| --- | --- |
| pnpm check | 通过：strict TypeScript、类型感知 Oxlint、Prettier、生成类型新鲜度、5 个 Schema/16 个示例、28 个模块导入边界、文档检查 |
| 离线行为测试 | 149 项通过，包含真实 SQLite、网络/解析/取消和工具编排 |
| 构建 MCP 测试 | 4 项通过；真实 SDK 2 stdio、重启续页、恶意目标阻断、非法配置、2025-11-25 初始化兼容 |
| pnpm test:built | 通过：tarball 在干净目录安装，native SQLite、已安装 MCP bin、Schema 和真实 worker 正文提取 |
| pnpm test:live | 主实例采用 brave,google：英文域限定返回 3 条，前 2 条共 4 段精确原文，webfetch 同快照读取成功，中文 MDN 结果 3 条，loopback 被拒绝 |
| 手工验收客户端 | call-tool 调用真实服务，loopback 返回 FETCH_BLOCKED 且命令非零退出，属于预期失败 |

真实英文搜索含证据约 7.458 秒；该单次测量不是延迟 SLA。英文和中文查询均可能因为候选采集上限返回 partial，此次原文目标 2/2 完成，没有伪装全网穷尽。

## 实际来源与上游限制

英文来源包括 modelcontextprotocol.io 的 Tools 规范与官方 C# SDK 子域；中文来源为 developer.mozilla.org 的 zh-CN Promise 与异步 JavaScript 文档。完整响应留在本机被忽略的 artifacts/live/result.json，公开仓库只提交必要汇总。

初期 DuckDuckGo 查询成功后出现 CAPTCHA；Google 部分中文查询零结果；Bing 样本相关性较弱。这些是实际观察，不宣称匿名搜索无限稳定。最终通过的组合使用 Brave/Google 网页适配器，未使用商业 API 或 Key；临时引擎探针容器已删除，主 18888 实例保持 Healthy。

## 发布前修正

独立子 Agent 与根任务复核后修正：categories 扩大 SearXNG 引擎范围、来源 ID 不一致、总超时丢失已有候选、取消后提前返回、同游标调用取消互相影响、非法孤立配置被忽略、解析并发配置失效和 CSS 噪声。每项都补了相应回归证据。

公开内容扫描没有命中实际实例 secret；data、artifacts、.cache、环境文件均被忽略。GitHub 仓库和 CI 结果在推送后核对。

## 未验证与未实现

没有验证 Windows、持续多日压力或所有搜索站点。向量召回、RRF/BM25/神经精排实验、PDF、浏览器渲染和 HTTP 多租户未实现。置信度仅描述原文证据可追溯性，真假概率保持 null。
