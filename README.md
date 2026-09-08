# Web Research MCP

免费、免搜索 API Key 的本地联网 MCP 服务。提供 `websearch` 和 `webfetch`：按域名搜索、读取网页、返回原文证据、相关性说明与可追溯的快照。

上游使用自建 SearXNG 的匿名网页适配器。无需搜索账号、免费 Key 或商业试用额度，不自动回退到付费服务。本项目采用 [MIT](LICENSE)，SearXNG 是独立部署的 AGPL-3.0-or-later 项目。机器和网络仍有成本，免费上游可能限流、验证码或零结果，服务会明确报告。[上游准入规则](docs/06-upstream-policy.md)

## 已实现

- **指定站点**：sites、exclude_domains、子域开关、IDNA/PSL 校验；返回结果和证据跳转都检查范围。
- **原文证据**：显式 evidence_mode=extract 有界补抓；返回连续 quote、来源、完整文本哈希、Unicode 偏移和 snapshot cursor。
- **可解释评分**：词法相关性记录方法、版本与依据；confidence 表示证据可追溯性，fact_probability 固定为 null。
- **持久化续读**：SQLite 保存冻结候选池、网页快照与随机游标，重启后在有效期内仍可读取。
- **受控抓取**：DNS 固定连接、SSRF/跳转检查、robots、压缩/输出上限、取消、独立解析 worker 与资源清理。
- **真实 MCP 入口**：SDK 2、stdio 和旧版初始化兼容路径；结构化输出与文本输出一致。

版本为 0.1.0，业务契约为 0.2-draft。默认评分是词法基线；PDF、动态浏览器、向量召回、BM25/RRF 实验和神经精排不属于本版本。high 证据等级不表示事实一定正确。

## 快速开始

需要 **Node 24.20.0**、**pnpm 10.12.3** 和 Docker Compose。Node 版本记录在 `.node-version`。

```sh
git clone https://github.com/wyzz973/web-research-mcp.git
cd web-research-mcp
pnpm install --frozen-lockfile
pnpm searxng:setup
docker compose -f deploy/compose.yaml up -d
pnpm build
```

SearXNG 只监听 `127.0.0.1:18888`。初始化将随机实例 secret 写入被 Git 忽略的 `.cache/searxng/settings.yml`；这不是搜索 API Key。固定镜像和精确引擎配置见 [部署说明](deploy/README.md)。

运行一次带原文证据的搜索：

```sh
pnpm call websearch '{"query":"MCP tools structuredContent","sites":["modelcontextprotocol.io"],"limit":3,"evidence_mode":"extract","max_evidence_results":2}' --config config/local.example.json
```

读取公开网页：

```sh
pnpm call webfetch '{"url":"https://www.sqlite.org/fts5.html","format":"text","max_chars":3000}'
```

把搜索返回的 evidence[].snapshot_cursor 或抓取返回的 next_cursor 原样传入，即可读取已保存文本。以下占位值要替换为实际响应：

```sh
pnpm call webfetch '{"cursor":"ACTUAL_CURSOR","max_chars":3000}'
```

示例使用匿名 **Brave 网页搜索 + Google 网页搜索**，不使用商业 Search API。可选择其他经准入的引擎；可达性与结果质量会变化。

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
        "SEARXNG_ENGINES": "brave,google"
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
SEARXNG_URL=http://127.0.0.1:18888 SEARXNG_ENGINES=brave,google pnpm test:live
```

check 包括类型、类型感知 lint、格式、生成类型、Schema、模块边界、文档、离线行为与 MCP 测试。test:built 将真实 tarball 安装到干净目录，验证 SQLite、MCP 入口和解析 worker。test:live 明确访问上游，不放入普通 CI；失败会保存到被 Git 忽略的 artifacts/live/result.json，不自动绕过封锁。

执行证据见 [实施验收记录](docs/verification/2026-09-08-implementation.md)。离线测试不能保证所有网站随时可抓取。

## 文档

| 入口 | 内容 |
| --- | --- |
| [设计](DESIGN.md) / [架构](docs/03-architecture.md) | 不变量、模块、生命周期与存储 |
| [工具契约](docs/04-tool-contracts.md) / [站点与证据](docs/12-sites-evidence-scoring.md) | 参数、错误、分页、原文与评分 |
| [AGENTS](AGENTS.md) / [CONTRIBUTING](CONTRIBUTING.md) | Agent 与开发者入口 |
| [技术栈](docs/07-technology-stack.md) / [编码规范](docs/08-coding-standards.md) | 依赖、类型、风格与资源 |
| [项目规范](docs/09-development.md) / [测试规范](docs/10-testing.md) / [文档规范](docs/11-documentation.md) | 开发、验证、发布和文档归属 |
| [调研](docs/01-landscape.md) / [算法](docs/02-retrieval-ranking.md) / [来源](docs/sources.md) | 选型依据与后续实验 |
| [路线图](docs/05-roadmap-evaluation.md) / [决策](docs/decisions/README.md) | 本版范围与后续计划 |
| [DSH 实践参考](docs/references/deepseek-harness-practices.md) | 借鉴内容与明确取舍 |
