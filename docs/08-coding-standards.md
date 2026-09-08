# 编码规范

类型：开发参考。适用于本仓库运行源码、测试与脚本；JSON/Markdown 的排版由对应工具处理。

## 文件、命名与格式

- 文件与目录用 kebab-case；函数/变量用 camelCase；类型、接口和类用 PascalCase；真正固定的协议常量可用 UPPER_SNAKE_CASE。
- 领域类型使用明确名词，如 SearchProvider、SnapshotStore、ResolvedFetchSpec，避免 Manager、Helper、Utils 混装不同职责。
- 两空格缩进、单引号、无分号、ESM；使用 `node:` 导入内置模块，类型导入使用 `import type`。函数和模块首选命名导出，工具要求的配置默认导出除外。
- 源码相对路径带 `.ts`，禁止依赖当前工作目录推导模块资源位置；worker 和内置资源以 import.meta.url 定位。
- 一个文件围绕一个职责组织；出现互不相关的生命周期或依赖时拆分，不为凑行数机械拆文件。共享抽象要有真实使用者，避免只有一个实现的层层转发。

## 类型与输入

开启 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、noImplicitOverride 和 noFallthroughCasesInSwitch。外部未知值用 unknown，经校验后收窄；禁止随意 any、双重断言和非空断言。

无可替代的第三方类型适配可局部使用断言，注释解释依据与验证位置；禁止文件级关闭类型/安全规则。闭合联合按 status/kind switch，并用 assertNever 检查穷尽；可扩展的上游错误码通过已记录的未知分支映射。

跨模块的不透明身份使用带品牌的 SourceId、SnapshotId、RequestId、CursorToken，避免裸 string 误传。JSON 出入口仍为普通字符串，在所有者模块转换；不得将 URL 当文件路径，也不得从 cursor 直接拼接路径。

输入约束校验覆盖 MCP JSON、配置、HTTP 响应、worker 消息和数据库反序列化。同进程已经验证的领域对象信任 TypeScript，不为它们重复做结构解析。业务不变量如资源剩余额度仍需在执行时检查。

## 默认值与依赖

流程固定为 parse → resolve → execute → present。parse 校验来源数据；resolve 把用户输入、部署配置和硬约束合成完整不可变 Spec；execute 不补默认值；present 只格式化结果，不再出网。

省略和 null 含义明确：输出未知 published_at 用 null；输入 cursor 未提供就是省略，不接受空字符串代表没有。展示层可用 hostname 补标题，但不能把展示后备值当上游原始字段。

配置由启动入口读取并传入依赖，不在库函数里读 process.env。引擎和网络策略、存储、时钟等通过构造参数或工厂参数显式注入。模块 import 不创建连接、注册计时器、初始化数据库或启动线程。

## 异步、取消与清理

所有 promise 必须 await、return 或由明确的后台任务管理器接管；不用裸 void 吞异步错误。并发任务有全局和每域上限，拒绝对用户控制列表直接无限 Promise.all。

取消信号和总 deadline 贯穿 DNS 等待、socket、读取、重试和 worker；重试只消费剩余预算，不重新开始总计时。将 timedOut、cancelled、HTTP 状态、Provider 状态分别记录，不能因为拿到部分字节就把超时记为成功。

资源获取后立即进入 try/finally。关闭按“停止接收 → 取消在途 → 等待结束 → 关闭连接/存储”的顺序，设置有界关停时间。提取器同步执行时通过 worker 终止实现硬超时。清理失败要记录，不能覆盖最初错误，也不能假称资源已释放。

## 错误与日志

可预期的 Provider/网络/策略失败归一化为领域结果；执行缺陷保留 cause 并在最外层映射为脱敏 INTERNAL_ERROR。catch 中收到 unknown 先收窄；没有理由的空 catch、catch 后返回成功、HTTP 非 2xx 直接当正文成功均禁止。

错误语义归 [工具契约](04-tool-contracts.md)，不要在各适配器重定义同名错误的含义。stdout 不得 console.log；结构化 stderr 日志记录 request_id、阶段、耗时、字节和错误码。默认不记录完整查询、正文、Cookie 或带敏感参数的 URL。

## 网络与数据

所有运行时出网都经过统一策略入口。禁止在 Provider、提取器或 formatter 中直接调用未包装的 fetch。手动跳转逐次校验，DNS 检查结果固定到实际建连；代理不能绕过同等出网限制。

HTML 是不可信输入。DOM 禁止脚本、资源加载与网页触发的任意回调；Markdown 只保留允许的链接协议，不依靠“已转 Markdown”就认为内容可信。深度、字符数、解压字节与解析时间均有上限。

URL 去重保守处理，保留语义 query 参数；正文哈希针对明确编码和格式的完整快照。Unicode code point 偏移不能直接用 JS UTF-16 的 length/slice 代替；中文、emoji、组合字符都要有定位用例。

SQL 必须参数化；事务内不执行网络或模型调用。数据库 schema_version 单调递增，拒绝未知未来版本；升级失败回滚，禁止隐式删除用户已有 data 目录。临时文件使用私有随机目录并明确所有权，不能递归清理来源不明路径。

## 测试与注释

测试描述行为与触发条件，如“上游挑战页返回 blocked”，避免“works correctly”。只 mock 网络、时钟等不确定边界，保留真正的编排、提取、序列化和存储。不要写镜像实现逻辑的测试；断言输出、状态和独立可观测的资源结果。

公共接口 JSDoc 说明非显然的输入、输出、失败、所有权和单位；参数与返回值存在约束时写清。注释解释附近代码不能直接表达的原因，不叙述开发过程。TODO 说明缺口与触发条件；影响当前正确性的缺陷用 FIXME，并进入实施清单。

文档以中文为主，代码标识、稳定错误码与机器字段用英文；注释选择最清晰的语言，不逐行双语重复。
