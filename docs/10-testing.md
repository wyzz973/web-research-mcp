# 测试与质量规范

类型：开发参考。测试验证承诺的行为，不以测试数量或快照数量替代质量。

## 检查分层

| 层 | 验证对象 | 输入与证据 |
| --- | --- | --- |
| 文件检查 | JSON 语法、Markdown 本地文件链接、换行 | 当前可运行，不证明业务行为 |
| Schema | Draft 2020-12 合法性、全部示例、成功和错误分支 | Ajv2020；check:schemas 已接入 |
| 单元 | 去重、排序、配置 resolve、偏移、错误映射 | 精确输入输出、边界情况；不出真实网络 |
| 业务集成 | Provider → 业务 → 真提取器/存储 | 只替换网络、DNS、时钟等不确定边界 |
| MCP 回放 | 实际 stdio 进程与工具请求/响应 | SDK client、录制网络 fixture、真实序列化 |
| 构建产物 smoke | plain Node 启动打包入口和 worker | 临时干净安装目录；不得读取 src |
| Live | 当前环境真实 SearXNG 和公开网页 | 无搜索 Key/账号，逐引擎结果和实际 URL |
| 检索评估 | 召回、排序与证据质量 | 冻结标注候选池，见算法与评估文档 |

网络策略测试可以注入受控 resolver/transport 作为测试依赖，但运行配置不提供任意私网放行开关。除返回错误以外，还要观察被禁止的目标没有收到连接。MCP 成功回放可使用本地模拟搜索服务；webfetch 的模拟 transport 必须通过仅测试装配注入，不能为了测试降低产品策略。

## 按变更选择检查

| 改动 | 本地必需证据 |
| --- | --- |
| 纯文档/示例 | 文件检查；Schema 相关示例需 Schema 校验 |
| 排序/规范化 | typecheck、lint、相关单元；可见结果改变时更新回放 |
| Provider 或上游白名单 | 上述检查、请求/失败 fixture、独立匿名 live smoke |
| 抓取/提取/网络策略 | 相关集成、禁止连接断言、异常 HTML、超时/取消、MCP 回放 |
| 存储/游标 | 事务和版本检查、完整分页拼接、重启续读、过期行为 |
| SDK/启动/构建依赖 | MCP 回放、干净产物 smoke、所声称平台的验证 |
| 仓库检查脚本 | 正例通过和对应反例失败 |

先跑相关检查；通过后不为提交动作重复跑相同测试。只有新修改、失败或未解决问题才扩大范围。CI 负责完整确定性测试矩阵。本项目不照搬 DSH 全文件 100% 覆盖率门槛；安全、错误、数据持久化和生命周期的关键行为必须覆盖，覆盖率报告用来发现未验证路径，不靠无意义断言凑数。

## 回放与快照

模型可见的非机械改动更新所属 MCP transcript fixture。录制只替换上游网络响应，服务注册、业务处理、提取和序列化保持真实。稳定化仅处理真正不确定的时间、随机 ID 和测试端口，并保留 source/snapshot/cursor 的关联关系；不能删除 status、warnings、URL 或正文让测试更容易通过。

回放预期输出只在显式录制命令更新，CI 只读。每次录制检查 diff，不能仅因为新输出来自当前实现就接受。成功依据包括正文哈希、引用定位和磁盘快照的独立读取，不依赖服务自己返回“成功”。

## 异步与资源

每个测试创建自己的临时目录、数据库和随机端口，在失败、取消和重试时也清理。不得固定 sleep 等待状态；等待可观察事件并设置总 deadline。不得从另一个测试文件导入 harness，以免重复注册用例。

关停检查包括未读 HTTP body、悬挂 parser worker、重试计时器、SQLite 连接和事件监听。延迟收到上游响应不应恢复已取消的请求。排序并发完成顺序不能改变稳定输出的 tie-breaker。

## 当前命令

命令以 package.json 为准：typecheck、lint、format:check、check:types、check:schemas、check:boundaries、check:docs、test、test:mcp、test:built、test:live 均已有实际实现。

pnpm check 汇总确定性检查；test 排除需要构建的 MCP 用例，test:mcp 先构建再启动真实 stdio。test:built 从 tarball 在干净目录安装，验证运行依赖、schema、bin 和真实解析 worker。test:live 明确访问自建 SearXNG 与公开网站，结果写入被 Git 忽略的 artifacts/live。

CI 使用 Node 24.20.0 / pnpm 10.12.3，在 Linux 冻结安装后执行 pnpm check 和 pnpm test:built。实时网络单列，不把验证码或缺少网络环境标成成功。

文件检查不检查外部 URL、Markdown heading anchor 或 Schema 语义；后者由 check:schemas 单独执行。所有检查范围与最新结果见 [实施验收](verification/2026-09-08-implementation.md)。

## 0.3.0 增量验收

`tests/workbench.spec.ts` 使用真实 loopback HTTP，校验 Host/Origin/token、请求大小与并发、浏览器断开和关停取消、实际 webfetch SSRF。Host 反例使用 node:http，不能用会改写 Host 的 fetch 假装已测 DNS 重绑定。

`tests/workbench-ui.spec.ts` 使用实际 HTML/JS + jsdom，仅替换网络，覆盖文本注入、链接协议、实际 token请求头、证据续读、取消与旧请求竞态。真实布局另用浏览器测试；DOM 测试不能声明移动端已验证。

`test:built` 同时验证打包后的 workbench 入口帮助、静态资源、会话注入与实际工具网络策略。CI 额外从冻结候选运行 evaluate.mjs；只复算、不出网重采样。原文精确引用另以保存的正文、SHA-256 和 Unicode 字符范围独立核对。
