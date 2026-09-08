# 调研来源与证据边界

访问日期统一为 **2026-09-08**。以下为本次实际在线读取的项目页、官方文档、模型卡或作者论文。项目当前分支及网页内容会变化；本次没有下载完整仓库、锁定 commit、运行项目或审核全部源码。后续采用某个依赖时，补充精确版本与许可文件快照。

正文中的工程路线、默认参数和实施优先级是本项目建议，不是来源承诺。没有沿用搜索结果中的第三方性能宣传。

## 搜索与项目

| ID | 一手资料 | 用于支持 |
| --- | --- | --- |
| S01 | [SearXNG About](https://docs.searxng.org/user/about.html) | 元搜索定位与自托管路线 |
| S02 | [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) | JSON、参数、公开实例限制 |
| S03 | [SearXNG DuckDuckGo engine](https://docs.searxng.org/dev/engines/online/duckduckgo.html) | 网页搜索适配存在 |
| S04 | [SearXNG Google engine](https://docs.searxng.org/dev/engines/online/google.html) | Google 适配与实现文档 |
| S05 | [mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) | 社区 MCP 搜索参考与 MIT 声明 |
| S06 | [duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) | 搜索/抓取组合、限流、缓存、HTTP 202 问题 |
| S07 | [DDGS](https://github.com/deedy5/ddgs) | 多搜索来源库及当前 API/MCP 能力 |
| S08 | [Mwmbl](https://github.com/mwmbl/mwmbl) | 非营利、自有索引、覆盖局限与 AGPL 声明 |
| S09 | [MediaWiki Search](https://www.mediawiki.org/wiki/API:Search) | 领域站内搜索接口 |
| S10 | [Brave API 定价](https://brave.com/search/api/) | 当前 Search 价格和月免费额度 |
| S11 | [Brave API 计费 FAQ](https://api-dashboard.search.brave.com/documentation/resources/help-feedback) | 无独立免费计划、零预付额度与信用卡条件 |
| S12 | [Mojeek API](https://www.mojeek.com/services/search/web-search-api/) | 付费计划和有限试用；不能标成无限免费 API |

## 网页读取与 MCP

| ID | 一手资料 | 用于支持 |
| --- | --- | --- |
| S13 | [官方 Fetch 参考服务](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) | URL fetch 与分页交互参考 |
| S14 | [Mozilla Readability](https://github.com/mozilla/readability) | JS 正文提取候选 |
| S15 | [Trafilatura](https://github.com/adbar/trafilatura) | Python 正文/元数据提取候选 |
| S16 | [Crawl4AI](https://github.com/unclecode/crawl4ai) | 爬取、Markdown、署名文案边界 |
| S17 | [Jina Reader 仓库](https://github.com/jina-ai/reader) | URL 转换和自托管参考 |
| S18 | [Jina Reader 官方页](https://jina.ai/reader/) | 匿名读取、Search Key 要求、RPM 与 token 额度 |
| S19 | [MCP TypeScript SDK README](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md) | v2 稳定线、包拆分与规范日期 |
| S20 | [MCP TS SDK v2 文档](https://ts.sdk.modelcontextprotocol.io/v2/) | 新实现应采用对应代际文档 |
| S21 | [MCP 2026-07-28 Tools 规范源码](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/tools.mdx) | schema、工具调用和返回结构 |
| S22 | [OWASP SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery) | 任意 URL 抓取的网络安全边界 |

## 召回、排序与评估

| ID | 一手资料 | 用于支持 |
| --- | --- | --- |
| S23 | [SQLite FTS5](https://www.sqlite.org/fts5.html) | 本地全文检索、BM25 分数方向、tokenizer 语义 |
| S24 | [Stanford IR Book：BM25](https://nlp.stanford.edu/IR-book/html/htmledition/okapi-bm25-a-non-binary-model-1.html) | 词项评分与长度归一化 |
| S25 | [RRF，Cormack 等，2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) | 基于名次的融合方法 |
| S26 | [MMR，Carbonell / Goldstein，1998](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf) | 相关性和多样性权衡 |
| S27 | [Sentence Transformers Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) | 先召回后精排的结构 |
| S28 | [BAAI bge-reranker-v2-m3 模型卡](https://huggingface.co/BAAI/bge-reranker-v2-m3) | 多语言精排候选；不代表本机已验证 |
| S29 | [HNSW](https://arxiv.org/abs/1603.09320) | 近似向量邻居搜索 |
| S30 | [SPLADE](https://arxiv.org/abs/2107.05720) | 学习式稀疏检索 |
| S31 | [ColBERT](https://arxiv.org/abs/2004.12832) | 后交互检索 |
| S32 | [微软 LambdaMART 概览](https://www.microsoft.com/en-us/research/publication/from-ranknet-to-lambdarank-to-lambdamart-an-overview/) | 学习排序演进与训练需求 |
| S33 | [HyDE](https://arxiv.org/abs/2212.10496) | 假想文档辅助零样本召回 |
| S34 | [BEIR](https://arxiv.org/abs/2104.08663) | 多领域零样本评估与 BM25 基线 |
| S35 | [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/) | 自有语料向量/混合检索引擎候选 |

## 未解决与排除项

- DuckDuckGo `/api` 本次重定向，未获得现行完整接口说明，不据此宣称有可用的官方免费 SERP API。
- MCP 官网部分规范页面读取失败，Tools 已通过官方 GitHub 对应规范源码核查；传输详细实现留到 SDK 版本锁定时继续核对。
- OpenSearch 相关文档入口本次仅返回跳转页，未取得足够正文，因此未将其放入已完成选型对比。
- Marginalia 仓库入口本次读取失败，仅作为后续搜索引擎探索线索，不列为已验证候选。
- 未核查百度、Google/Bing 商业 API 的当前开户与费用条件；表格中的 Google/Bing 只表示网页适配路线。
- 没有公共实例可用率、模型排名或性能数值的本项目实测结论。

## 工程规范补充核查

2026-09-08 补充读取 DeepSeek Harness 本地规则与实现，版本和采用范围见 [独立参考记录](references/deepseek-harness-practices.md)。技术栈补充依据为 [Node 发布表](https://nodejs.org/en/about/previous-releases)、[TypeScript 扩展名改写](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)、[Undici](https://github.com/nodejs/undici)、[Ajv Schema 支持](https://ajv.js.org/json-schema.html)、[Schema 类型生成器](https://github.com/bcherny/json-schema-to-typescript)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[Oxlint 类型感知检查](https://oxc.rs/docs/guide/usage/linter/type-aware.html)、[Prettier 配置](https://prettier.io/docs/configuration)、[Turndown](https://github.com/mixmark-io/turndown)。这些资料支持选型方向，不表示依赖组合或当前项目已通过构建运行。

## 站点与证据补充核查

2026-09-08 重新核查 [SearXNG 查询语法](https://docs.searxng.org/user/search-syntax.html) 与 Search API 的上游语法差异；读取 [Guo 等的校准论文](https://proceedings.mlr.press/v70/guo17a.html) 区分分数和校准概率，以及 [tldts](https://github.com/remusao/tldts)、[PSL](https://publicsuffix.org/list/) 作为域名处理参考。具体词法公式、置信等级和预算是本项目设计，未通过运行基准验证。
