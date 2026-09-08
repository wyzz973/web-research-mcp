# storage

已实现 SQLite 不可变文档快照、冻结搜索候选池与持久化 opaque 游标。

`createSnapshotStore({ directory, ttlSeconds, maxBytes })` 返回共享 `SnapshotStore` 接口；调用方拥有实例并在关停时调用 `close()`。每个调用同步执行短事务，不执行网络请求。

- `snapshots.sqlite` 使用 WAL、FULL 同步、参数化语句。目录权限 0700，数据库权限 0600；不接受数据库或目录本身为符号链接。
- 数据格式版本为 `PRAGMA user_version = 1`，包含单个 `records` 表和过期索引。未知版本和缺失/损坏的结构拒绝打开，保留原数据库。
- URL（去除 fragment，保留查询参数）产生稳定 `sourceId`；每个 LoadedDocument 对象产生随机观察 UUID，再与格式组合为 `snapshotId`。同一次观察的 text/markdown 各自具有完整 UTF-8 SHA-256、正文和 Unicode code point 段落偏移。段落保留所有换行、空白和组合字符，不更改正文。
- 32 字节随机游标使用 base64url 输出，数据库只存游标 SHA-256。fetch/search 互相隔离；未知或过期记录返回 `CURSOR_EXPIRED`，有效的其他工具游标返回 `CURSOR_MISMATCH`。
- 内部 SourceId、SnapshotId、CursorToken 使用共享品牌类型及工厂；持久化读取先验证身份格式、来源 URL 和快照格式关系再恢复类型。JSON/MCP 字符串与已有 schema-v1 存储表示保持不变。
- 搜索池仅允许首次插入，拒绝覆盖有效记录。JSON 写入拒绝 undefined、非有限数字、循环对象和非 JSON 实例；读取边界解析 JSON，文档读取额外验证类型、完整哈希和全部段落位置。业务游标和候选池的具体 payload schema 由工具模块校验。
- 每次写入事务先清理过期记录，再写新记录。数据库容量不足整笔回滚，有效记录不会提前驱逐。`maxBytes` 为保守磁盘预算：预留 WAL 共享内存及事务空间后，仅约三分之一用于 SQLite 主文件页数；预算不是可保存正文的净字节数。每次事务前后 checkpoint 并截断 WAL；不能回收被外部读取锁定的 WAL 时拒绝新写入。

配置一个目录应由一个 MCP 服务实例管理；外部工具长事务可能导致 `STORAGE_UNAVAILABLE`。SQLite 页文件保留已释放页面供复用，不因过期清理自动缩小主文件。降低预算至现有文件容量以下会拒绝启动，不能删除已有记录绕过。

真实 SQLite 验证位于 [storage.spec.ts](../../tests/storage.spec.ts)，覆盖 Unicode、重启续读、游标篡改/类型隔离、过期、未来版本、持久化损坏、容量与权限。
