# ADR 0006：无 Docker 的原生 SearXNG

Status: accepted

Implementation: implemented

日期：2026-09-10。用户要求不用 Docker 也能使用 SearXNG。

## 决策

默认部署入口改为隔离的原生 Python + Granian，仍通过相同 HTTP API 连接现有 MCP。Docker 模板继续作为可选方式，原生脚本不调用 Docker 或 sudo，不安装系统 Python/系统服务。

源码使用与既有镜像相同的 commit 并验证压缩包 SHA-256，Python 和 wheels 固定版本及哈希。安装与生命周期共用锁；成功凭据最后写入，关键依赖损坏时可修复。原生后端的缓存通过私有 TMPDIR 隔离，保留现有实例暂停状态，不用清空缓存绕过上游限制。

后台监督器使用私有 Unix socket 和随机 token 接收 status/stop，停止时等待所拥有的进程组退出。端口占用与无法确认身份的进程明确拒绝，禁止仅凭 PID 文件或端口执行 kill。

## 替代方案

**只给出手工 pip/Flask 命令。** 容易混入系统依赖、错误读取外层 Git 版本、遗漏配置与进程清理，不能满足直接可用的交付。

**把 Docker 隐藏在自动脚本中。** 仍然依赖 Docker，不符合用户要求。

**改用公共 SearXNG 实例。** 不解决自建部署，且公共实例常有 JSON 和访问限制。

## 验证与范围

macOS 使用真实原生 SearXNG 验证 health/UI/static assets、限定引擎、完整 MCP 搜索与证据链路；Linux CI 另验证原生冷安装和生命周期。MCP 工具契约不变，包版本为 0.2.1。Windows 原生、开机自启和操作系统配额不在本次范围。
