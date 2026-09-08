# 相关项目与搜索引擎调研

核查日期：2026-09-08。依据项目 README、官方文档与模型卡；没有安装运行或完成安全审计。“适合”一栏是本项目的判断。许可证为仓库声明线索，引入具体版本时核对 LICENSE 和 NOTICE，不据此直接作再分发结论。

用户进一步确认：仅接入公开、匿名、免注册、免 Key、无付费要求的上游搜索。以下保留商业服务作为调研排除记录，不代表计划支持。

## 可以复用和参考的项目

| 项目 | 定位与已核查能力 | 对本项目的价值 | 取舍 |
| --- | --- | --- | --- |
| [SearXNG](https://docs.searxng.org/user/about.html) | 开源元搜索，聚合外部搜索服务 | 复用其搜索适配生态 | 首选独立部署后端；不等于自有全网索引 |
| [ihor-sokoliuk/mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) | SearXNG MCP 接入，仓库标 MIT | 最接近 TS 搜索接入的参考，后续作为基线比较 | 自建实例仍需运维；不把 README 的客户端验证视为本项目验证 |
| [nickclyde/duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) | Python MCP，搜索、fetch、限流、缓存和续读，MIT | 简单两工具组合、失败处理参考 | 单搜索源相关风险；README 已记录 HTTP 202 空响应问题 |
| [deedy5/ddgs](https://github.com/deedy5/ddgs) | Python 元搜索库，现有 API、MCP、extract 入口，MIT | 无需自己维护所有搜索网页解析器的候选 | 当前已不仅是 DDG 包装；放入可选适配层，避免 TS 主进程依赖 Python |
| [官方 Fetch 参考服务](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) | 获取 URL、转换内容、支持 start_index/max_length | 检查 MCP fetch 的最小交互设计 | 参考实现不等于适合公开部署的完整网络边界 |
| [Mozilla Readability](https://github.com/mozilla/readability) | JavaScript 正文提取组件 | TS 栈静态网页提取首选候选 | 对文章友好；复杂文档、代码和表格必须测保真度 |
| [Trafilatura](https://github.com/adbar/trafilatura) | Python 正文、元数据提取与多种输出 | 跨提取器质量基线或后续 worker | 多运行时成本；不能假定所有站点都优于 Readability |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | 爬取、提取和 LLM Markdown，仓库标 Apache-2.0 | 动态网页与复杂采集的后续候选 | 初版单页抓取不需要整个框架；README 另有署名措辞，采用时核对具体许可文本 |
| [Jina Reader](https://github.com/jina-ai/reader) | URL → LLM 文本，提供自托管材料与托管入口 | 输出结构、提取策略的参考和独立对照 | 自托管与托管有不同限制；默认不转发 URL 到第三方服务 |
| [Mwmbl](https://github.com/mwmbl/mwmbl) | 非营利开源搜索，自有索引、志愿者爬取，AGPL-3.0 | 研究自主搜索引擎的索引与排序 | 项目自述索引小于商业搜索；作为探索来源，当前托管 API 配额未核实 |

建议独立实现薄 MCP 层，复用 SearXNG 和提取库，而不是完整 fork 某个社区 MCP。原因是本项目重点包含多来源检索实验、快照证据、中文召回与可评估排序，需要稳定的内部契约。

## 免费搜索来源与接入现实

| 来源 | 无付费 API 的路径 | 边界 | 推荐等级 |
| --- | --- | --- | --- |
| 自建 SearXNG | 自己部署，通过 HTTP JSON API 调用 | 必须开启 json；上游引擎可能超时、限流；公共实例常禁用 JSON | 主后端 |
| DuckDuckGo 网页搜索 | SearXNG DDG 适配或独立网页适配 | 不是有 SLA 的通用免费 SERP API；空响应与挑战页需区分 | 上游之一；直连后备实验 |
| Google / Bing 网页搜索 | 按 SearXNG 当前适配能力配置 | 页面可免费使用不意味着自动访问接口稳定；所在网络决定可用性 | 实测后按配置启用 |
| Wikipedia / MediaWiki | 官方站内搜索 API | 搜索特定百科站点，不能冒充全网搜索；遵守实例访问规则 | 知识查询的领域补充 |
| Mwmbl | 开源搜索及自托管研究 | 覆盖与实时性需评估；托管访问条件未确认 | 探索候选 |
| Brave Search API | 每个计划每月 $5 免费额度；Search 为 $5/千请求 | 约对应 1,000 次 Search 请求，需信用卡；不是旧版“每月 2,000 次免费计划” | 排除接入：需要 Key |
| Mojeek API | 官方提供有限试用，需联系 | 当前正式 API 为付费计划；不能因网页免费而标成免费 API | 排除接入：付费/试用模式 |
| Jina Reader / Search | r.jina.ai 基础匿名读取可免费使用；s.jina.ai 需 Key | 当前匿名 Reader 20 RPM；Search 无 Key 不开放，Key 额度按 token 计 | Search 排除接入；匿名 Reader 仅抓取对照 |

依据：[SearXNG API](https://docs.searxng.org/dev/search_api.html)、[DDG 适配](https://docs.searxng.org/dev/engines/online/duckduckgo.html)、[Google 适配](https://docs.searxng.org/dev/engines/online/google.html)、[MediaWiki 搜索](https://www.mediawiki.org/wiki/API:Search)、[Brave 当前计费说明](https://api-dashboard.search.brave.com/documentation/resources/help-feedback)、[Brave 定价](https://brave.com/search/api/)、[Mojeek API](https://www.mojeek.com/services/search/web-search-api/)、[Jina 官方额度表](https://jina.ai/reader/)。额度是本次核查快照，实施前重新核对。

DuckDuckGo 旧 `/api` 入口本次重定向至搜索页，未能据此核实 Instant Answer 当前接口条件；不要把历史 Instant Answer 用法作为通用全网搜索实现依据。

中文场景优先测试 SearXNG 中实际可用的中文结果，加入中文、英文和双语查询对照。百度等额外来源保留候选，当前未核查其适配和 API 条件，不纳入已支持清单。

引擎准入应落实到具体接入方式：某品牌的免费网页搜索与同品牌付费 API 分别判断。SearXNG、DDGS 等聚合层只使用通过免 Key 准入的显式引擎清单，不能直接继承所有默认来源。没有通过检查的清单时搜索应报告配置未完成，而非自动选一个未知来源。

## 搜索后端与本地检索引擎的区别

| 组件 | 管理的数据 | 适合阶段 |
| --- | --- | --- |
| SearXNG | 上游返回的候选列表 | 从 M1 开始 |
| SQLite FTS5 | 本项目保存的页面、段落与缓存 | 少量本地资料检索，M2/M3 |
| Qdrant | 已生成的向量和 payload，可组合检索 | 语义检索收益得到验证以后 |
| Mwmbl 等自主搜索系统 | 自己爬取与维护的网页索引 | 独立研究方向，不作为本项目首版依赖 |

FTS5 提供 BM25 和 tokenizer 扩展；Qdrant 提供预取和融合查询能力。二者都不会自动获得全网内容。[FTS5](https://www.sqlite.org/fts5.html)、[Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)
