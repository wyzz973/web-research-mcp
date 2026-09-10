# 原生 SearXNG 验证

日期：2026-09-10。平台：macOS ARM64；Node 24.20.0、uv 0.8.12、独立 Python 3.12.11、Granian 2.8.2；SearXNG commit 3fdc6d753a339b5f4a7dc5842c94c0d8324726f1。

## 已执行的真实验证

- 固定源码压缩包 SHA-256 通过；重新使用 Node fetch 下载也核对相同哈希。
- 创建隔离 venv，安装哈希锁定依赖；原生源码版本、JSON 格式与四个免 Key 引擎核对通过。
- 首先在 18889 启动原生服务，health、首页、CSS 均 HTTP 200；真实 MCP 限定域搜索及原文证据成功。
- 停止该原生实例后，停止本项目 Docker SearXNG 容器，原生服务接管原 18888 地址；既有 MCP 配置无需改变。
- 18888 原生服务完成英文限定域搜索、段落证据、完整原文与相关证据续读、中文限定域搜索、loopback 拒绝检查。
- 实际停止服务后模拟 Granian 依赖缺失：安装检查拒绝损坏环境，setup 重新安装锁定 wheels，关键模块重新导入成功，原 secret 与设置字节保持不变。
- 原生缓存隔离至 `.cache/searxng-native/data`；首次验证阶段的缓存通过 SQLite backup 保留，未清除上游暂停状态。native-smoke 校验缓存实际位置。

## 检查范围

生命周期测试使用真实受控子进程验证并发、错误 token、端口冲突、SIGTERM/KILL 后实际退出、启动取消和陈旧状态。安装测试通过隔离 fixture 验证非准入源码、哈希拒绝、环境隔离、未准备与运行中刷新拒绝。真实 Granian 和上游结果单独记录，不由 fixture 冒充。

pnpm check 通过：248 项行为测试 + 4 项真实 MCP 入口测试，合计 252 项；类型、类型感知 lint、格式、生成类型、6 个 Schema/18 个示例与模块/文档检查通过。pnpm test:built 的干净 tarball 安装与实际解析 worker 通过。本机原始联网数据保存在被 Git 忽略的 artifacts/native-searxng-2026-09-10。

首次 18888 完整 live-smoke 成功，保留日志为 live.log。随后最终重查时，英文搜索、两份原文证据及相关续读再次成功，但中文步骤遇到 UPSTREAM_BLOCKED，完整脚本因此非零退出，原始响应为 final-live.json。没有隐瞒波动或清空上游限制；这不影响原生启动、HTTP API 和已观察到的英文实际链路证明。

## 限制

原生模式不要求 Docker，但首次安装需要 uv 与下载网络。使用单 worker/四线程，不承诺容器级资源隔离或开机自启；Windows 原生未支持。免费引擎的限流和验证码边界保持不变。
