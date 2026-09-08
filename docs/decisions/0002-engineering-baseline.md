# ADR 0002：面向 Codex 持续开发的单包工程基线

Status: accepted

Implementation: implemented

日期：2026-09-08。参考版本与来源见 [DSH 开发实践](../references/deepseek-harness-practices.md)。

## 问题

仅有功能调研无法约束后续 Agent 在错误语义、模块依赖、默认值、验证与文档上的选择。反复重写规范或把模拟成功当完成，会让这个服务难以持续迭代。

## 决策

采用单包 TypeScript/Node 24、官方 MCP SDK、SearXNG、独立安全抓取和正文转换。模块通过显式参数装配。JSON Schema 是公共字段的唯一作者源；领域类型与 wire 类型分离。

借鉴 DSH 的 Service Definition/Provider/Consumer 职责、resolve/execute 区分、严格类型、资源所有权、可见输出回放、真实构建入口验证，以及每类文档一个归属。根 AGENTS 保持简短并链接详细规则。

本项目使用已有 docs/decisions 承载 Agent Note 的决策职能，避免再建一套内容重复的 .agents/notes。验证证据统一进入 docs/verification。accepted 决策与运行实现状态分开记录。

## 考虑的替代方案

**完整采用 DSH Cordis 插件框架。** 当前只有两个工具和一个搜索后端，不需要热插拔、双端类型图或完整 Agent runtime；引入它会扩大装配、打包和依赖边界。

**用 Python/FastMCP 作为主服务。** DDGS 与正文提取生态很有价值，但当前选择统一 TS 工具进程和类型体系；如果提取对照证明需要 Python，可以增加独立 worker，保持公共工具接口稳定。

**手写两套 JSON Schema 和 Zod。** 容易出现默认值、可空字段与错误分支漂移。使用现有 schemas 生成/适配 SDK 所需表示，接入正确性通过真实协议往返验证。

**只做单元测试或追求全文件 100% 覆盖率。** 前者无法证明入口可用，后者可能诱导镜像测试。采用重要行为覆盖、MCP transcript、构建产物 smoke 与独立 live 证明。

## 后果与验证

精简架构保留了后续增加 Provider 和 worker 的空间，但 SDK/schema 适配、HTML worker 资源约束及原生 SQLite 包仍需 M1/M2 验证。每项有明确实施任务，不能由文档审批替代运行结果。

当前实际命令与验证范围见 package.json 和实施验收记录，未登记空成功脚本。未来添加检查工具不得改变上述测试分层或免 Key 硬要求。
