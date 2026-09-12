# 技术栈与依赖策略

类型：实现参考。运行依赖与工具版本已固定于 package.json 和 pnpm-lock.yaml，Node 24.20.0、pnpm 10.12.3。两个工具、SQLite 和 stdio 入口均已实现；执行证据见 [实施验收](verification/2026-09-08-implementation.md)。

## 基础技术

| 层 | 选择 | 理由与边界 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS | 当前基线限定 24.x，补丁版本锁定后测试；不自动宣称支持所有更高主版本 |
| 语言 | TypeScript 6 稳定线、ESM、strict | 单包强类型；使用 tsc 输出普通 JS |
| 包管理 | pnpm，精确 packageManager 版本 | 一份 lockfile；不混用 npm/yarn 安装产生锁文件 |
| 协议 | 官方 MCP TypeScript SDK v2 | server 用运行依赖，client 用集成测试依赖；先验证目标客户端支持 |
| 传输 | stdio；Streamable HTTP 后续 | 初版无 HTTP 服务框架；不自建 JSON-RPC 实现 |
| 搜索 | 自建 SearXNG HTTP JSON | 原生 Python/Granian 或可选 Docker，固定源码/依赖及精确免 Key 引擎 |
| 网络 | Undici + Node DNS + ipaddr.js | 使用受控 dispatcher/lookup，手动处理跳转；未经策略包装不可直接 fetch |
| 域范围 | Node URL/IDNA + tldts/固定 PSL 数据 | 区分合法站点、公共后缀和 hostname 边界，纯匹配逻辑独立 |
| 基线相关性 | Node Intl.Segmenter + 版本化词法覆盖 | 无推理模型或外部 Key；记录 Node/ICU/locale 以复现分词 |
| 解析 | jsdom + Mozilla Readability | 提取在 worker 执行；DOM 不执行脚本、不加载子资源 |
| Markdown | Turndown + GFM 插件 | 保留可表达的标题、代码与表格，复杂表格降级需标记 |
| 校验 | JSON Schema 2020-12 + Ajv2020 + ajv-formats | schemas 为对外字段唯一源；不并行手写另一套 Zod 字段定义 |
| 类型生成 | json-schema-to-typescript | 生成 wire 类型，不生成领域语义；不支持的 schema 条件仍由运行校验负责 |
| 持久化 | SQLite + better-sqlite3，已实现 | 短事务、参数化 SQL、WAL；原生模块在目标架构实测 |
| 测试 | Vitest 4 稳定线 | 单元、业务集成、stdio 回放分层；live 网络独立运行 |
| 静态检查 | Oxlint + 匹配版本的类型检查扩展 | 借鉴 DSH；M1 验证类型感知规则实际启用 |
| 格式 | Prettier + EditorConfig | 两空格、单引号、不写分号、统一 LF；格式问题不占业务评审时间 |

Node 24 的 LTS 状态与 SDK v2 依据本次官方文档核查；这不是依赖组合已通过测试的证明。[Node 发布表](https://nodejs.org/en/about/previous-releases)、[SDK README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md)

HTTP、正文与存储候选来自其维护者资料：[Undici](https://github.com/nodejs/undici)、[Readability](https://github.com/mozilla/readability)、[Turndown](https://github.com/mixmark-io/turndown)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)。正式采用时确认 Node 24 兼容性、许可、原生二进制来源和依赖树，不用 README 性能宣传作为本项目指标。

域名库候选依据 [tldts](https://github.com/remusao/tldts) 和 [Public Suffix List](https://publicsuffix.org/list/)。采用时固定数据版本并同时处理 ICANN 与 private suffix；公共后缀识别不是 DNS 可达性或安全判断。

## 单包与编译

源码采用 `.ts` 相对导入；TypeScript `rewriteRelativeImportExtensions` 将构建产物中的扩展名改写为 JS。采用 NodeNext 模块解析，避免依靠 bundler 才能成功解析的路径。初版无 bundler、workspace、路径别名或多个 Host/Client TypeScript 程序。[TypeScript 配置说明](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)

`src/` 为运行源码，`tests/` 为测试，`scripts/` 为仓库工具，`dist/` 为构建输出。静态检查和普通测试只读源码；发布入口 smoke 明确先 build 再执行 dist。解析 worker 必须由同一构建产出，测试须证明其路径在干净安装目录仍可解析。

参考编译选项见 [配置模板](../config/tsconfig.base.example.json)。根 tsconfig.json 用于 typecheck，tsconfig.build.json 仅包含 src；不能把测试打包成运行入口。实际依赖的类型声明若要求新的选项，需记录理由，不能关闭 strict 来绕过。

## Schema 接入验证

Ajv 使用 2020-12 实例，并显式注册格式检查。默认值由 resolve 函数应用，校验器不自动改写输入。SDK 如果要求特定 Schema 适配形式，由 mcp 模块包装现有 JSON Schema；MCP 测试证明 inputSchema/outputSchema、structuredContent、错误分支与目标客户端完整往返，不能靠类型断言声称兼容。[Ajv](https://ajv.js.org/json-schema.html)、[类型生成器](https://github.com/bcherny/json-schema-to-typescript)

wire 类型由 generate:types 生成到 src/generated，check:types 检查新鲜度；其表示不了的条件不在业务层重复模拟。生成文件禁止手改。领域 SourceId、SnapshotId、ResolvedSearchSpec 等是独立的内部模型，通过映射接入 wire 类型。

## 依赖引入顺序

SDK、网络、正文提取、Schema、测试工具与 SQLite 已加入本版本。Playwright、Python worker、embedding、reranker 与向量数据库都不是基础安装依赖，只在对应功能和评估一起交付时引入。采用一个可配置 Provider 接口，不预先造插件市场。

每次新增或升级依赖记录：实际版本、用途、许可线索、传递依赖变化、Node/架构支持、替代方案与验证结果。生产直接依赖和开发工具固定准确版本，lockfile 固定完整依赖图；容器固定 digest。维护更新可用新版本，但必须有 diff 与检查证据，禁止发布路径使用 latest。

## 明确不沿用的 DSH 技术

不引入 Cordis、Schemastery、Typert、全插件加载器、Python SDK、Web UI、双编译图或大仓库的全部检查脚本。借鉴其类型、边界、验证与决策实践，保留这个服务的独立启动与部署能力。取舍记录见 [ADR 0002](decisions/0002-engineering-baseline.md)。

原生部署使用独立 Python 3.12.11 与 Granian 2.8.2，不属于 MCP Node 包运行依赖；通过 uv 安装固定 wheels，说明见 [原生部署](../deploy/native/README.md)。

## 本地验收页面

工作台使用 Node 内置 HTTP 与静态 HTML/CSS/ES Modules，复用 TypeScript 业务运行时；无额外 Web 框架或前端构建依赖。浏览器展示与 MCP stdio 为独立适配器，HTTP 只监听 loopback。候选排序采用本地 BM25 与词集相似度 MMR 实验，默认不启用额外推理模型。设计见 [ADR 0007](decisions/0007-search-quality-workbench.md)。

0.5.0 可选动态渲染使用 Crawl4AI 0.9.3、Python 3.12.11、Playwright 1.62.0 及其固定浏览器 revision；Python wheel 哈希锁定，Chromium 保留 sandbox。Node 负责全部实际网络策略，Python 本身禁止互联网 socket，子进程通过本地管道交换有界数据。无额外模型调用，仍免 Key。
