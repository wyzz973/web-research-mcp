# 架构决策记录

ADR 保存会影响后续维护的取舍；当前执行状态与验证结果分别在实施清单和 verification 中维护。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-free-first.md) | 上游免费免 Key、薄 MCP 服务 | 已实现，用户免 Key 约束保持 |
| [0002](0002-engineering-baseline.md) | 单包 TS 与参考 DSH 的工程规范 | accepted，工程检查与运行实现已建立 |
| [0003](0003-sites-evidence-scoring.md) | 域范围、原文证据与可解释评分 | accepted，契约 0.2-draft，核心功能已实现 |
| [0004](0004-runtime-implementation.md) | SDK/持久化/生命周期及发布验收 | implemented |
| [0005](0005-paragraph-evidence-and-source-metadata.md) | 段落证据与来源展示元数据 | 0.2.0 / 0.3-draft |
| [0006](0006-native-searxng.md) | 无 Docker 原生部署 | 0.2.1 |
| [0007](0007-search-quality-workbench.md) | 引擎诊断、排序评估与本地工作台 | 0.3.0 |

新增架构、跨模块契约、持久化格式、重大依赖或验证策略使用 [模板](template.md)。局部重命名、排版等机械修改无需新 ADR。既有决策仍适用时更新原文，不制造相同结论的重复记录。
