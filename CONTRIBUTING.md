# 开发入口

两个工具和真实 stdio 入口已实现。安装、配置与检查命令见 [README](README.md)。

## 开始一个任务

1. 阅读 [Agent 规则](AGENTS.md)、[设计](DESIGN.md) 和 [上游准入](docs/06-upstream-policy.md)。
2. 确认任务的可观察行为、所属模块和受影响的文档/Schema；已有代码时先查看差异和最近相关变更。
3. 按 [技术栈](docs/07-technology-stack.md) 与 [编码规范](docs/08-coding-standards.md) 实现最小完整链路。
4. 根据 [测试规范](docs/10-testing.md) 运行相关验证；模型可见改动要检查实际 MCP 输出。
5. 更新所属文档、必要的 ADR 和 [验证记录](docs/verification/README.md)，报告结果和未验证项。

## 建立开发基线

使用仓库指定的 Node/pnpm，执行 pnpm install --frozen-lockfile、pnpm check。修改发布入口或运行依赖时再执行 pnpm test:built；Provider 变更另做 pnpm test:live，保留实际上游失败。

后续算法与动态网页扩展见 [实施清单](docs/05-roadmap-evaluation.md)。不要提交只有空函数或固定成功响应的工具来表示链路已完成。

工程流程、分支、依赖升级、版本与发布规则由 [项目规范](docs/09-development.md) 维护。
