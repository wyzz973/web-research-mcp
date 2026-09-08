# DeepSeek Harness 开发实践参考

核查日期：2026-09-08。参考本地 deepseek-harness 的干净 master，HEAD 为 `0a53fb55bea101816fa226bb964ae2bed71c343b`，remote upstream 指向 `https://github.com/deepseek-ai/deepseek-harness`。本次读取规则、配置和 Web 实现，没有修改该仓库或运行其测试。下列链接固定到核查 commit。

这份记录证明可观察到的工程实践，不据此判断整个仓库是否全由 Codex 编写。

## 采纳与适配

| DSH 中观察到的实践 | 本项目采用方式 | 参考文件 |
| --- | --- | --- |
| 根 Agent 规则简短链接各主题 | AGENTS + DESIGN + 专项规范 | [AGENTS](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/AGENTS.md) |
| Definition / Provider / Consumer 分工 | search/fetch 定义接口，Provider 实现，tools 消费 | [架构](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/architecture.md)、[Web 类型](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/web/web/src/types.ts) |
| ESM、strict、可选字段和索引访问检查 | 单包 NodeNext + tsc，保留严格选项 | [TypeScript 配置](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/tsconfig.base.json) |
| 显式 resolve(request) 再执行 | 用户参数与部署配置只在 resolve 合并 | [根规则](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/AGENTS.md) |
| 只校验真正不可信或跨进程边界 | MCP、HTTP、worker、配置和持久化校验 | [根规则](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/AGENTS.md) |
| 状态事实独立报告，dispose 等待真正结束 | 超时、取消、HTTP 状态独立；关闭等待 I/O 与 worker | [防御性模式](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/defensive-patterns.md) |
| 校验 DNS 后固定实际连接地址 | 统一出网策略，禁止二次解析绕过 | [网络实现](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/web/web-fetch-http/src/network.ts) |
| 网络读取与 Markdown 展示分开 | fetch network/extract 与 tools presenter 分层 | [HTTP Provider](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/web/web-fetch-http/README.md)、[fetch 工具](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/web/tool-web/src/fetch.ts) |
| 同步 HTML 转换会阻塞超时计时器 | 提取放入有界可终止 worker，失败不回原始 HTML | [fetch 转换限制](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/web/tool-web/src/fetch.ts) |
| 测试真实入口和外部结果，只 mock 不确定边界 | stdio client + 真实业务 + 构建产物 smoke | [测试规范](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/testing.md) |
| 源码检查与构建产物检查分开 | 普通测试不读 dist，发布 smoke 明确 build | [开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/development.md) |
| 一个事实一个文档归属，决策记录写替代方案 | 使用 docs/decisions，验证另存 verification | [文档规则](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/AGENTS.md)、[Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/README.md) |
| 维护良好的依赖可减少自有实现负担 | 不手写协议与解析器，依赖变更写依据 | [依赖决策](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md) |

## 有意不照搬

- DSH 的 Cordis、Schemastery、Typert、多包 monorepo、Host/Client 双编译图：本项目暂不需要这些扩展机制。
- DSH 的付费 Provider 和 with-key e2e：本项目的真实上游测试必须免 Key。
- DSH 的全文件 100% coverage：本项目以关键行为、失败路径和真实入口为必需证据。
- DSH 的同源重定向限制和非 2xx 当资源结果：本项目另行定义公开跨域跳转的重新验证、HTTPS 降级拒绝，以及非 2xx 的工具错误映射。
- DSH 的会话日志与双 SDK 投影：本项目保存工具相关快照和录制证据，不实现完整 Agent 会话系统。
- DSH 的双语文档镜像、字数预算和全部自定义检查：采用中文主文档与少量实际检查，随规模增加再引入生成器。

以上是对本项目的取舍，不是对 DSH 设计的评价。具体选择由 [ADR 0002](../decisions/0002-engineering-baseline.md) 维护。
