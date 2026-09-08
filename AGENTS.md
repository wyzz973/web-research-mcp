# Agent 开发规则

本项目是免费免 Key 的联网搜索 MCP 服务。先读 [README](README.md)、[DESIGN](DESIGN.md) 和所改模块的文档；真实进度以 README、实施清单和验证记录为准。

- 用户明确要求的 [上游准入规则](docs/06-upstream-policy.md) 适用于所有搜索和降级路径；不得自行接入免费 Key、代持 Key 或付费服务。
- 采用 [技术栈](docs/07-technology-stack.md) 和 [编码规范](docs/08-coding-standards.md)。MCP、业务编排、Provider、存储保持显式依赖边界；不引入全局服务定位器。
- JSON、配置、网络、worker 和持久化入口校验；同进程已验证类型不反复解析。默认值只在 resolve 阶段处理，执行函数接收完整 Spec。
- 改工具字段时同步修改 schemas、示例、实现与对应回放；[工具契约](docs/04-tool-contracts.md) 定义语义，schemas 定义机器可读字段。
- 不把挑战页或 Provider 失败当零结果，不把源码测试当发布入口测试。按 [测试规范](docs/10-testing.md) 选择检查，只报告实际执行的命令、结果和未验证项。
- 所有异步资源有明确所有者与清理路径；取消和超时要传到真实 I/O 与 worker，并等待结束。stdout 只供 MCP，日志写 stderr。
- 不为通过检查而删除行为断言、扩大快照忽略范围、降低资源要求或放宽网络策略。例外必须局部、说明原因，并保留回归验证。
- 架构、依赖、跨模块契约、存储格式或测试策略变更需同步更新所属 [ADR](docs/decisions/README.md)；局部机械编辑不要求新增决策记录。
- 文档按 [文档规范](docs/11-documentation.md) 各有归属。尚未实现的能力不能写成已经可用；不要提供不存在的启动或检查命令。
- 保留用户与其他任务的修改，先看状态再编辑。Git、PR 与完成标准见 [项目规范](docs/09-development.md)；未经任务授权不发布包或部署服务。
- 新依赖优先选择维护良好且适合边界的库；固定版本并更新 lockfile，说明它替代的代码或提供的能力。
- DeepSeek Harness 仅为参考资料，不能作为本项目隐含路径依赖，也不能因为参考它而修改它。
