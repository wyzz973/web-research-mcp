# 工程规范基线验证

本记录为实现前的历史文件检查；后续运行结果见 [实施验收](2026-09-08-implementation.md)。
日期：2026-09-08。范围：设计、技术栈、Agent/项目/编码/测试/文档规范、格式配置、Schema 草案及文档检查脚本。

## 参考基线

只读检查 DeepSeek Harness 的工作区和开发文件；master HEAD 为 `0a53fb55bea101816fa226bb964ae2bed71c343b`，`git status --short` 无输出。本次没有修改它或运行其业务检查。参考路径和采用规则见 [DSH 记录](../references/deepseek-harness-practices.md)。

## 执行记录

环境：macOS，本次宿主 shell 的 Node 为 v25.9.0；项目目标为 Node 24，文件检查在宿主运行不构成 Node 24 服务兼容证明。

| 实际执行 | 结果 | 能证明的范围 |
| --- | --- | --- |
| `node scripts/check-docs.mjs` | 通过；最终内容检查覆盖 56 个文本文件、19 个 JSON 与 68 个本地文件链接 | 文本换行、JSON 语法、Markdown 本地文件存在 |
| `uv run --no-project --with jsonschema python -`，内联读取 schemas 与 examples | 通过；4 个 Draft 2020-12 Schema、10 个示例，启用 FormatChecker | Schema 合法性和构造数据一致性 |
| 同一内联校验中的分页断言 | 通过；首尾页拼接哈希、Unicode offsets、snapshot_id 和末页 cursor 一致 | 构造分页例子的自洽性，不是运行分页实现 |
| Schema 反例校验 | 同时给 url/cursor 和 empty 携带非空结果均被拒绝 | 两个关键非法输入/结果不能通过 Schema |
| `python3 -`，临时目录复制检查脚本，分别注入坏链接、非法 JSON、多余末尾换行 | 三项均非零退出，临时目录自动清理 | 检查脚本实际拒绝对应坏输入 |

uv 为 Schema 检查使用临时工具环境，没有向本项目安装生产依赖。本轮未运行 pnpm lint/typecheck/build；这些命令尚未实现。

## 独立读者复核

独立只读 Agent 从项目文档回答开工入口、技术栈、模块与资源、工具语义、完成证据和 DSH 借鉴范围。首次检查发现并修复：末页 truncated 定义不一致、基础网络验证错放 M2、装配根缺少导入例外。随后针对这三项复核通过。

错误码与 http_status 的 Schema 同步在主线修改后也已确认；最终 Schema 校验覆盖更新内容。复核仅检查文件，不代表业务或网络已测试。

## 未验证项

尚未安装或锁定生产依赖、构建 MCP 服务、部署 SearXNG、实测搜索引擎、执行正文抓取或跨平台验证。未来的 typecheck/lint/构建/回放/live 命令没有登记为空脚本。package.json 只有文件检查，private=true，无 bin、运行依赖或安装钩子。
