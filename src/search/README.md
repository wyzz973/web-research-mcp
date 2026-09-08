# search

搜索 Provider 与 SearXNG 适配，入口为 [searxng.ts](searxng.ts)。

- `createSearxngProvider({ baseUrl, engines, timeoutMs })` 实现共享 `SearchProvider`；所有请求只访问部署者配置的端点，不发现公共实例、不跟随跳转、不传递凭据或 Cookie。
- 固定准入名称为 `duckduckgo`、`bing`、`google`、`brave`、`mojeek`，指 SearXNG 的匿名网页适配器。部署者仍须保证实例内这些名称没有被改绑到其他适配器。
- `engines` 每次明确发送，同时省略 `categories`：SearXNG 会把显式分类中的引擎合并到 engines，从而扩大实际搜索范围。`query` 中以 `!`、`:` 开头的控制词以及 `<数字` 超时控制被拒绝；普通文本和 `site:` 保留。站点分支添加单个 `site:`，应用层仍须调用 `matchesScope` 严格过滤结果。
- JSON 响应限制 2 MiB，候选限制 200 条。正常零条才是 exhausted；有结果并伴随引擎错误保留 errors，零结果与引擎失败同时发生则抛领域错误。
- SearXNG 是受信任基础设施端点，可使用 loopback；此客户端与任意网页的公网抓取策略不同。固定目标、禁止跳转、响应限制和在途请求取消集中在 Provider 内，`close()` 取消并等待自有请求。

查询控制语义核查于 2026-09-08：[官方查询说明](https://docs.searxng.org/user/search-syntax.html)、[解析器源码](https://github.com/searxng/searxng/blob/master/searx/query.py)。接口与错误回归测试见 [search-searxng.spec.ts](../../tests/search-searxng.spec.ts)。真实引擎可用性必须另行执行 live smoke，本模块模拟测试不构成上游可用性证明。
