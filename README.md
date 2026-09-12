# Web Research MCP

免费、免搜索 API Key 的本地联网 MCP 服务。提供 `websearch` 和 `webfetch`：按域名搜索、读取网页、返回原文证据、相关性说明与可追溯的快照。

上游使用自建 SearXNG 的匿名网页适配器。无需搜索账号、免费 Key 或商业试用额度，不自动回退到付费服务。本项目采用 [MIT](LICENSE)，SearXNG 是独立部署的 AGPL-3.0-or-later 项目。机器和网络仍有成本，免费上游可能限流、验证码或零结果，服务会明确报告。[上游准入规则](docs/06-upstream-policy.md)

## 已实现

- **指定站点**：sites、exclude_domains、子域开关、IDNA/PSL 校验；返回结果和证据跳转都检查范围。
- **原文证据**：显式 evidence_mode=extract 有界补抓；默认每结果最多 3 段完整上下文、合计 4,000 字符，返回精确定位及更多相关证据游标。
- **前端来源展示**：source_metadata 返回站名、域名、实际 URL、favicon/logo/预览图、日期和逐字段来源；未抓取时明确使用 URL 后备。
- **可解释评分**：词法相关性记录方法、版本与依据；confidence 表示证据可追溯性，fact_probability 固定为 null。
- **持久化续读**：SQLite 保存冻结候选池、网页快照与随机游标，重启后在有效期内仍可读取。
- **受控抓取**：DNS 固定连接、SSRF/跳转检查、robots、压缩/输出上限、取消、独立解析 worker 与资源清理。
- **真实 MCP 入口**：SDK 2、stdio 和旧版初始化兼容路径；结构化输出与文本输出一致。

版本为 0.4.0，业务契约为 0.3-draft。新增引擎冷却/恢复诊断、56 条中英文查询的评估工具、可选 BM25/MMR 候选排序与本地验收页面。默认保留上游顺序；PDF、动态浏览器、向量召回和神经精排不属于本版本。RRF 仅有离线函数，在线没有独立引擎排名，不伪造融合结果。high 证据等级不表示事实一定正确。

## 可视化观察每一步

打开 [过程观察](http://127.0.0.1:18900/trace)，可以实际运行搜索或 webfetch，并查看运行历史、步骤树、瀑布时间条、输入输出与中文解释。“上一步/下一步”只回看已记录步骤，不重发搜索。普通 MCP 调用也写入同一数据目录的 traces.sqlite，可通过输出 trace_id 关联。

默认仅记录元数据；观察页明确勾选后可记录有界查询/正文预览，敏感字段始终屏蔽。最近 100 次/24 小时，数据不上传第三方。成功搜索页短缓存 60 秒，相同在途请求合并，控制上游启动间隔和并发；partial/错误不缓存，也不绕验证码。详见 [小白观察与调试指南](docs/14-observability.md)。

## 在浏览器里验收

```sh
pnpm searxng:start
pnpm workbench
```

打开 [本地工作台](http://127.0.0.1:18900)：输入查询与 sites，切换排序，检查原文片段、完整快照、来源图标及逐引擎观察。界面复用真实业务服务，不展示伪造结果。详见 [工作台使用指南](ui/README.md)。

```sh
pnpm search:doctor  # 主动执行一次查询，退出 2 表示有可用结果但部分引擎降级
pnpm eval           # 离线比较冻结候选，不出网
pnpm eval:collect   # 显式低频采集，默认仅 3 条，不自动标注
```

评估框架区分失败、未标注与实际测量；本版标签为 Agent 审阅，不能当成人工金标。评估范围、数据与复现方法见 [评估指南](evals/README.md)。

## 快速开始

需要 **Node 24.20.0**、**pnpm 10.12.3** 和 **uv**；本机原生运行 SearXNG 无需 Docker。Node 版本记录在 `.node-version`，原生部署支持 macOS/Linux。

```sh
git clone https://github.com/wyzz973/web-research-mcp.git
cd web-research-mcp
pnpm install --frozen-lockfile
pnpm searxng:setup
pnpm searxng:start
pnpm build
```

SearXNG 只监听 `127.0.0.1:18888`。首次 setup 下载固定源码、隔离 Python 与哈希锁定依赖；配置、secret、日志与缓存保存在被 Git 忽略的 `.cache/searxng-native/`。不改系统 Python，无需搜索 API Key。用 `pnpm searxng:status` 查看状态、`pnpm searxng:stop` 停止。详见 [原生部署](deploy/native/README.md)；[Docker 部署](deploy/README.md) 仍为可选方式。

运行一次带原文证据的搜索：

```sh
pnpm call websearch '{"query":"MCP tools structuredContent","sites":["modelcontextprotocol.io"],"limit":3,"evidence_mode":"extract","max_evidence_results":2}' --config config/local.example.json
```

读取公开网页：

```sh
pnpm call webfetch '{"url":"https://www.sqlite.org/fts5.html","format":"text","max_chars":3000}'
```

把搜索返回的 evidence[].snapshot_cursor 传给 webfetch 可读完整原文；next_evidence_cursor 可读更多相关段落（view=evidence）。普通文档分页使用 next_cursor。以下占位值要替换为实际响应：

```sh
pnpm call webfetch '{"cursor":"ACTUAL_CURSOR","max_chars":3000}'
```

示例使用匿名 **Brave 网页搜索 + DuckDuckGo 网页搜索**，不使用商业 Search API。可选择其他经准入的引擎；可达性与结果质量会变化。

## 连接 MCP 客户端

配置客户端使用 Node 24 启动 dist/mcp/stdio.js。以下为常见 mcpServers 格式，路径需替换成本机路径：

```json
{
  "mcpServers": {
    "web-research": {
      "command": "/absolute/path/to/node24/bin/node",
      "args": ["/absolute/path/to/web-research-mcp/dist/mcp/stdio.js"],
      "env": {
        "SEARXNG_URL": "http://127.0.0.1:18888",
        "SEARXNG_ENGINES": "brave,duckduckgo"
      }
    }
  }
}
```

也可用 `--config file.json` 指定配置。WEB_RESEARCH_DATA_DIR 覆盖数据目录；默认在用户目录 `.local/share/web-research-mcp`。搜索未配置时 webfetch 仍可用，非法配置启动失败。

stdio 会等待客户端输入；没有普通命令行输出是正常行为。stdout 只传 MCP，日志写 stderr。`--help` 和 `--version` 为独立 CLI 查询。

## 开发与验收

```sh
pnpm check
pnpm test:built
SEARXNG_URL=http://127.0.0.1:18888 SEARXNG_ENGINES=brave,duckduckgo pnpm test:live
```

check 包括类型、类型感知 lint、格式、生成类型、Schema、模块边界、文档、离线行为与 MCP 测试。test:built 将真实 tarball 安装到干净目录，验证 SQLite、MCP 入口和解析 worker。test:live 明确访问上游，不放入普通 CI；失败会保存到被 Git 忽略的 artifacts/live/result.json，不自动绕过封锁。

0.4.0 的真实步骤、缓存与取消验证见 [可观测验收报告](docs/verification/2026-09-12-observability.md)。

0.3.0 的完整测试、浏览器链路与 56 条查询结论见 [本版验收报告](docs/verification/2026-09-10-search-quality-workbench.md)。

原生部署实测见 [无 Docker 验证](docs/verification/2026-09-10-native-searxng.md)。其他执行证据见 [0.2.0 段落与展示验收](docs/verification/2026-09-09-paragraph-evidence.md) 和 [初版实施记录](docs/verification/2026-09-08-implementation.md)。离线测试不能保证所有网站随时可抓取。

## 文档

| 入口 | 内容 |
| --- | --- |
| [设计](DESIGN.md) / [架构](docs/03-architecture.md) | 不变量、模块、生命周期与存储 |
| [工具契约](docs/04-tool-contracts.md) / [站点与证据](docs/12-sites-evidence-scoring.md) / [段落与展示](docs/13-evidence-presentation.md) | 参数、错误、续读、原文与来源字段 |
| [AGENTS](AGENTS.md) / [CONTRIBUTING](CONTRIBUTING.md) | Agent 与开发者入口 |
| [技术栈](docs/07-technology-stack.md) / [编码规范](docs/08-coding-standards.md) | 依赖、类型、风格与资源 |
| [项目规范](docs/09-development.md) / [测试规范](docs/10-testing.md) / [文档规范](docs/11-documentation.md) | 开发、验证、发布和文档归属 |
| [调研](docs/01-landscape.md) / [算法](docs/02-retrieval-ranking.md) / [来源](docs/sources.md) | 选型依据与后续实验 |
| [路线图](docs/05-roadmap-evaluation.md) / [决策](docs/decisions/README.md) | 本版范围与后续计划 |
| [DSH 实践参考](docs/references/deepseek-harness-practices.md) | 借鉴内容与明确取舍 |
