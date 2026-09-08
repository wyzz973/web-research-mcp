# MCP 接入

stdio.ts 负责装配、配置和关闭。server.ts 使用 SDK 2 的 fromJsonSchema + Ajv2020 注册两个工具，并返回同一份业务对象的结构化和文本表示。serveStdio 处理现代协议与旧版初始化入口；旧协议兼容通过真实帧测试。
