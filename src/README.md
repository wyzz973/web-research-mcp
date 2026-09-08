# 运行源码

mcp/stdio.ts 是唯一装配入口；mcp/server.ts 适配两个工具到 SDK。tools 编排 search/fetch/ranking/storage，shared 保存域模型、配置、错误和校验，generated 为 Schema 生成的 wire 类型。

搜索、抓取、排序和存储的独有语义分别在各模块 README。源码测试与 dist 构建产物测试分开，模块依赖由 check:boundaries 检查。
