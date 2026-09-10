# SearXNG 原生部署（无需 Docker）

支持 macOS / Linux，绑定本机 loopback。MCP 仍由 Node 24 运行；本目录提供固定版本 SearXNG 的独立 Python 环境及 Granian WSGI 服务，不改变系统 Python。

## 准备与运行

需要 Node 24、pnpm 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)（本次验证使用 0.8.12）。首次 setup 需要联网下载源码、Python（若本机没有指定版本）和 wheels。

```sh
pnpm searxng:setup
pnpm searxng:start
pnpm searxng:status
```

默认地址为 `http://127.0.0.1:18888`，与 config/local.example.json 一致，可直接使用原 MCP 搜索配置。start 返回 ready 后才算启动完成；日志保存在 `.cache/searxng-native/service.log`。

```sh
pnpm call websearch '{"query":"MCP tools structuredContent","sites":["modelcontextprotocol.io"],"limit":2,"evidence_mode":"extract","max_evidence_results":1}' --config config/local.example.json
```

停止或以前台方式运行：

```sh
pnpm searxng:stop
pnpm searxng:run
```

run 的 Ctrl+C 会清理被监督的进程组。start 启动后台进程，但不安装开机自启服务；系统重启后再次运行 start。stop 不删除数据、源码或环境。

## 端口与 Docker 模式

原生和 Docker 模式不能同时占用 18888。start 发现端口被占用会拒绝，绝不按端口或陈旧 PID 杀进程。首次从本项目 Docker 模式切换时，先明确停止原容器：

```sh
docker compose -f deploy/compose.yaml stop searxng
pnpm searxng:start
```

这条 Docker 命令仅用于迁移旧容器；全新原生安装、启动和日常使用完全不调用 Docker。也可以使用独立端口：

```sh
pnpm searxng:start --port 18889
SEARXNG_URL=http://127.0.0.1:18889 SEARXNG_ENGINES=brave,google pnpm call websearch '{"query":"MCP tools"}'
```

原生服务已经运行时，切换端口需先 stop。Windows 原生管理暂不支持；MCP 可连接其他机器提供的 SearXNG，不能把 WSL/Windows 运行视为已验证。

## 固定版本与私有状态

- [source.json](source.json) 固定源码 commit、源码压缩包 SHA-256、Python 3.12.11 与 Granian 2.8.2。
- [requirements.in](requirements.in) 来自对应上游依赖；[requirements.lock](requirements.lock) 固定传递依赖和发行文件哈希。
- 安装只允许 wheel，不自动尝试系统编译或安装编译器。没有对应 wheel 的平台会明确失败。
- 源码、venv、私有设置、日志、控制 socket 和 SQLite 缓存均位于项目 `.cache/searxng-native/`，不进入 Git。
- 源码采用上游支持的 version_frozen 机制标记版本，避免错误读取外层 MCP 仓库的 Git 信息。
- Python临时目录固定为该实例的 data 子目录，因为此 SearXNG 版本通过 tempfile 决定缓存路径；不与其他原生实例共享系统临时缓存。

仅保留 [共同模板](../settings.template.yaml) 中四个免 Key 网页适配器，Native 与 Docker 采用相同的上游政策。实例 secret 及控制 token 自动生成，目录 0700、设置/控制/日志 0600；不在命令行、输出或 Git 中暴露。它们不是上游 API Key。

元搜索后端仍可能出现 CAPTCHA、限流或零结果。原生部署改变运行方式，不保证上游持续可用。

## 更新、修复与验证

setup 已完成时会核查安装凭据、配置哈希、Python 版本/虚拟环境位置和关键依赖导入。依赖损坏或版本/config 变化时，先 stop 再 setup；setup 重新安装哈希锁定的 wheels 并保留原实例 secret。不得手改生成 settings.yml，修改模板后按此顺序刷新。

安装与启停共用生命周期锁；setup 期间撤销完成凭据，完成所有检查后才原子写回。取消会清理当前操作，失败环境不可被当成 ready。异常中断遗留的 installer lock 只有在记录的进程确实不存在时才自动回收；无法确认所有权时停止并提示检查。

```sh
node scripts/searxng-native-smoke.mjs
SEARXNG_URL=http://127.0.0.1:18888 SEARXNG_ENGINES=brave,google pnpm test:live
```

native-smoke 检查受控进程身份、health、HTML、CSS、私有缓存和引擎配置，不访问搜索上游。test:live 才验证真实 MCP 搜索/原文链路。Linux CI 单独执行无 Docker 的首次安装、启动、smoke 和停止；本机实测见 [验证记录](../../docs/verification/2026-09-10-native-searxng.md)。

原生服务使用 1 个 Granian worker 和 4 个阻塞线程，没有 Docker 的 cgroup 内存/CPU 限额；需要操作系统级配额时由部署者管理。SearXNG 自带网络超时与 MCP 层的请求/抓取预算继续生效。

依据：[SearXNG 安装说明](https://docs.searxng.org/admin/installation.html)、[开发快速开始](https://docs.searxng.org/dev/quickstart.html)、固定源码的 requirements-server.txt 和 version.py。
