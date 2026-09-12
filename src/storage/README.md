# storage

已实现 SQLite 不可变文档快照、冻结搜索候选池与持久化 opaque 游标。

`putEvidence` / `getEvidence` 持久化有界选段计划，使用同一 `records` 表的独立 `kind=evidence` 命名空间；与同 ID 的搜索池隔离。计划只写一次、禁止覆盖有效记录，沿用 JSON 校验、事务容量和过期规则；具体计划 Schema 由工具层校验。游标仍使用 fetch/search 两类，选段续读只需保存计划 ID 与偏移，不在每页重复保存全文。该命名空间无需 SQL 版本迁移。

`createSnapshotStore({ directory, ttlSeconds, maxBytes })` 返回共享 `SnapshotStore` 接口；调用方拥有实例并在关停时调用 `close()`。每个调用同步执行短事务，不执行网络请求。

- `snapshots.sqlite` 使用 WAL、FULL 同步、参数化语句。目录权限 0700，数据库权限 0600；不接受数据库或目录本身为符号链接。
- 数据格式版本为 `PRAGMA user_version = 1`，包含单个 `records` 表和过期索引。未知版本和缺失/损坏的结构拒绝打开，保留原数据库。
- URL（去除 fragment，保留查询参数）产生稳定 `sourceId`；每个 LoadedDocument 对象产生随机观察 UUID，再与格式组合为 `snapshotId`。同一次观察的 text/markdown 各自具有完整 UTF-8 SHA-256、正文和 Unicode code point 段落偏移。段落保留所有换行、空白和组合字符，不更改正文。
- 32 字节随机游标使用 base64url 输出，数据库只存游标 SHA-256。fetch/search 互相隔离；未知或过期记录返回 `CURSOR_EXPIRED`，有效的其他工具游标返回 `CURSOR_MISMATCH`。
- 内部 SourceId、SnapshotId、CursorToken 使用共享品牌类型及工厂；持久化读取先验证身份格式、来源 URL 和快照格式关系再恢复类型。JSON/MCP 字符串与已有 schema-v1 存储表示保持不变。
- 快照 JSON payload 可选保存完整 `sourceMetadata`，读取时按 [source-metadata.schema.json](../../schemas/source-metadata.schema.json) 校验；字段存在但不合法时返回 `STORAGE_UNAVAILABLE`，不得静默丢弃。旧快照缺少该字段时仍正常返回，展示层负责后备元数据。这是 schema-v1 JSON payload 的向后兼容可选字段扩展，不修改 SQL 表或 `user_version`。
- 搜索池仅允许首次插入，拒绝覆盖有效记录。JSON 写入拒绝 undefined、非有限数字、循环对象和非 JSON 实例；读取边界解析 JSON，文档读取额外验证类型、完整哈希和全部段落位置。业务游标和候选池的具体 payload schema 由工具模块校验。
- 每次写入事务先清理过期记录，再写新记录。数据库容量不足整笔回滚，有效记录不会提前驱逐。`maxBytes` 为保守磁盘预算：预留 WAL 共享内存及事务空间后，仅约三分之一用于 SQLite 主文件页数；预算不是可保存正文的净字节数。每次事务前后 checkpoint 并截断 WAL；不能回收被外部读取锁定的 WAL 时拒绝新写入。

配置一个目录应由一个 MCP 服务实例管理；外部工具长事务可能导致 `STORAGE_UNAVAILABLE`。SQLite 页文件保留已释放页面供复用，不因过期清理自动缩小主文件。降低预算至现有文件容量以下会拒绝启动，不能删除已有记录绕过。

真实 SQLite 验证位于 [storage.spec.ts](../../tests/storage.spec.ts)，覆盖 Unicode、重启续读、游标篡改/类型隔离、过期、未来版本、持久化损坏、容量与权限。

## 可选本地执行轨迹

`traces.ts` 的 `createTraceStore({ directory, readOnly? })` 在同目录使用独立 `traces.sqlite`，与证据库生命周期及保留语义分开。单次写入短事务并立即可被另一个 MCP/工作台进程读取；`list()` 返回最近 100 条的摘要、真实 `span_count` 和空 `spans`，`get(id)` 返回完整有界轨迹。默认最多保留 24 小时/100 runs，每条最多 256 KiB，数据库主文件最多 64 MiB；SQLite WAL 自动 checkpoint，旧页复用。写入时清理过期和超量记录，读时也隐藏过期记录；关闭连接由 runtime 负责。

数据库使用 schema version 1、WAL、NORMAL 同步、100 ms busy timeout、目录 0700/数据库 0600。未知版本拒绝打开且保留原文件；损坏的 JSON 行不对外返回。记录器把可选诊断存储失败隔离于实际业务。

`running` 在拥有者进程 PID 明确不存在（ESRCH）时读取为 `interrupted`，不虚构结束时间；仍活跃或权限不可判断的其他进程保持 running，避免在途执行被误报中断。PID 被操作系统复用时采取保守策略，可能仍显示 running；不会杀进程或修改其他进程状态。独立 Node 子进程、并发父子 span、跨连接即时读取及隐私/容量限制由 [traces.spec.ts](../../tests/traces.spec.ts) 验证。
