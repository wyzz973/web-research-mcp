# 面向模型的共同约定

状态：设计草案，尚未实现。适用于 [web_search](web-search.md) 和 [web_fetch](web-fetch.md)。

读者是大模型。每一条约定都要回答同一个问题：模型读到这段输出后，能不能用最少的 token 做出正确的下一步。

## 1. 一个结果对象，两种呈现

核心库产出一个带类型的结果对象，它是唯一的契约。对外有两种呈现，由同一个对象生成，因此内容必然等价：

| 呈现 | 给谁 | 形式 |
| --- | --- | --- |
| 文本视图 | 模型 | 行式文本：固定的表头、结果块、页脚。网页正文保持 Markdown 原样 |
| JSON | 程序、CLI 的 `--json`、库的调用方 | 紧凑 JSON，省略空值，不做缩进 |

**MCP 默认只返回文本视图**，不声明 `outputSchema`，不返回 `structuredContent`。理由：

- Claude Code 和 Codex 在两者并存时只把结构化部分给模型，opencode 相反只用文本。两者并存时，模型在多数 harness 里读到的是 JSON。
- JSON 会把正文里的换行、引号、代码转义成一长串，既费 token，也让模型难读代码和表格。实测 Parallel 的返回就是这种形态。
- Exa 的官方 MCP 返回的也是纯文本块。

可以用配置改成 `json` 或 `both`。这条默认值要用契约评测来验证（同一批任务，比较两种呈现下的成功率、调用次数和 token），评测结果不支持就改。

## 2. 文本视图的格式

规则：

- 标签用英文小写，固定不变，让模型形成习惯。正文保持原语言。
- 一行一个事实。不用装饰性符号，不用表格，不用多级缩进。
- 来自网页的内容一律放在带 `untrusted` 标记的区块里（见第 8 节）。
- 只在需要时出现的行：来源状态只在有来源失败时出现，续取提示只在还有内容时出现。

表头、结果块、页脚的具体样子见两个工具各自的文档。

## 3. token 预算

- 每个工具都有 `max_tokens`，含义是「本次返回内容的大致上限」。我们不依赖任何模型的分词器，用按字符类别加权的估算：英文字母约 0.26、数字约 0.45、标点和符号约 0.55、空白约 0.12、CJK 字符 1。URL、代码、JSON 的 token 密度比正文高得多，统一按 0.27 会低估三四成，而低估正是输出被 harness 截断的原因，所以估算有意偏高。表头里回显估算值。
- **预算是二维的**：token 上限之外还有字符上限 `limits.max_output_chars`，默认 30,000，两者先到者为准。好几个 harness 是按字符截断工具输出的（Gemini CLI 40,000、OpenHands 30,000、Qwen Code 25,000），10,000 token 的英文内容约 37,000 字符，只限 token 会超。用 Qwen Code 的用户应把字符上限设成 24,000。
- 表头、页脚、目录都计入 `max_tokens`。最小单元写死：搜索是「标题行加地址行」，抓取是一个段落；最小单元都放不下时才减少条数或页数，并在 `notes` 里说明。
- 默认值给得宽：`web_search` 5,000，`web_fetch` 8,000。这与 Exa、Parallel 一次搜索的默认输出（实测约 4,200–4,600 token）相当，区别是我们的输出受预算控制，模型可以按需要调大调小。
- 单次调用的上限由服务端配置 `limits.max_output_tokens` 决定，默认 10,000。这个默认值取的是各 harness 截断上限的交集：Codex 约 10,000 token 后会砍掉中间部分，Claude Code 超过 10,000 token 警告、25,000 截断，Qwen Code 25,000 字符，opencode 51,200 字节。只用 Claude Code 的用户可以把它调到 20,000 以上；随包提供各 harness 的预设值。读更多内容不靠调大单次上限，靠游标续读。
- **自己截断，绝不交给 harness 截断**。截断只发生在段落边界，不切开代码块和表格行。
- 每次截断都写明三件事：给了哪一段（字符范围和百分比）、还剩多少、怎么取下一段。

## 4. 短 id 与游标

| 名称 | 形式 | 含义 | 有效期 |
| --- | --- | --- | --- |
| `ref` | 搜索 id（8 位）加结果号，如 `bxh98qpf:r1`（文档里的例子为了好读常写成 `k7f2:r1`）。输出里只印这个全称，跨调用、跨进程都能用；裸的 `r1` 不被接受 | 一条搜索结果。传给 `web_fetch` 时，我们知道它来自哪个查询和目标，可以默认沿用 | 24 小时 |
| `snapshot` | `s_` 加 6 位 | 一次抓取得到的不可变快照，带内容哈希 | 30 天 |
| 引用位置 | 快照 id 加字符范围，如 `s_k2m9qx:1820-2410` | 一段逐字原文在快照里的位置。模型引用证据时带上它，之后可以复核 | 同快照 |
| `cursor` | `c_` 加 8 位 | 「继续上一次」的位置，可以是搜索的下一页或文档的下一段 | 24 小时 |

id 都很短，因为模型要原样复述它们；但搜索 id 和游标留在模型上下文里的时间比有效期长，所以取 8 位，保证过期之后同一个 id 实际上不会再发给另一次搜索（第二轮审计的结论）。过期的 id 返回可恢复的错误，并说明怎么重新得到它。

## 5. 状态

| 状态 | 含义 | MCP 的 `isError` |
| --- | --- | --- |
| `ok` | 有结果 | 否 |
| `partial` | 有结果，但有来源失败，或内容因预算被截断 | 否 |
| `empty` | 至少一个来源确认没有结果 | 否 |
| `error` | 没有可用结果 | 是 |

「所有来源都失败」永远是 `error`，不会伪装成 `empty`。

## 6. 错误与提示

错误的形式是一个代码加一句可操作的话：发生了什么，下一步做什么。

| 代码 | 出现在 | 提示示例 |
| --- | --- | --- |
| `invalid_input` | 两者 | `recency must be one of day, week, month, year` |
| `rate_limited` | 两者 | `all sources are rate limited; retry after 30s` |
| `budget_exhausted` | 搜索 | `daily search budget reached; cached and free sources only` |
| `no_source_available` | 搜索 | `no search source is configured or healthy` |
| `blocked` | 抓取 | `the site refused automated access (HTTP 403); try another source from web_search` |
| `login_required` / `paywall` | 抓取 | `the page requires sign-in; only the public preview is available` |
| `payment_required` | 抓取 | `the site asks for payment (HTTP 402)` |
| `robots_disallowed` | 抓取 | `the site disallows automated reading of this path` |
| `not_found` | 抓取 | `HTTP 404; an archived copy from 2026-03-02 exists: pass archived=true` |
| `needs_javascript` | 抓取 | `the page is an empty app shell; pass render=true` |
| `unsupported_content_type` | 抓取 | `application/zip (12 MB) cannot be read as text` |
| `too_large` / `timeout` | 抓取 | 写明上限和已用时间 |
| `expired_ref` | 两者 | `this ref expired; run web_search again` |

`notes` 是成功响应里的提示，最多三行，只写会改变模型下一步的事：换了来源、应用了容错、结果被截断、结果偏少时的改写建议。

## 7. 输入容错

弱一些的模型经常把工具参数写错。能无歧义修复的就修复，并在 `notes` 里说明；有歧义的才报错。

| 输入 | 处理 |
| --- | --- |
| `sites` 或 `queries` 给了字符串 | 当作单元素数组 |
| 数字给了字符串 | 转成数字 |
| URL 缺协议 | 补 `https://` |
| `sites` 里给了完整 URL | 取域名 |
| 查询里写了 `site:example.com` | 挪进 `sites` |
| 未知参数 | 忽略，并在 `notes` 里列出 |
| `max_tokens` 超过上限 | 取上限 |
| `query` 和 `queries` 同时给 | 合并去重 |

测试环境可以打开严格模式，让这些情况直接报错。

## 8. 不可信内容

- 网页正文、标题、摘要只出现在带标记的区块里：`<results untrusted="true" nonce="…">` 和 `<page untrusted="true" nonce="…">`，结束标记带同一个 `nonce`。区块外的文字都是我们自己生成的。
- 固定的结束标记可以被伪造：页面只要在标题里写上 `</results>` 再跟一行假表头，就能让模型以为不可信区已经结束。所以结束标记带一次性 `nonce`；不可信文本里的 `<results`、`</results`、`<page`、`</page` 会被转义（搜索摘录在呈现时转义；网页正文在生成快照之前转义，这样字符偏移保持一致）；以我们表头页脚关键字开头的行会被加前缀。
- 提取时剥离 HTML 注释、不可见元素、零宽字符，并在表头里回显剥离数量，例如 `hidden_removed: 3`。不静默删除。
- 工具描述、错误信息、`notes` 里绝不拼接网页内容。
- 保留正文的结构（标题、列表、代码块）。有研究表明，保留结构的表示比压平的纯文本更不容易让模型服从注入指令。

## 9. 时间

- `web_search` 的表头回显当天日期。模型经常给查询拼上错误的年份。
- 每条结果尽量给发布日期或更新日期，来源不提供就不写，不猜。
- 每次抓取给出抓取时间和缓存状态：`miss`、`hit` 加年龄、`revalidated`。

## 10. 确定性与时延

- 相同输入加相同缓存状态，输出的顺序和格式相同。工具列表的顺序固定。
- 超过 5 秒的调用发进度通知。取消会传到真实的网络请求和 worker，并等待它们结束。

| 调用 | 目标中位数 | 硬上限 |
| --- | --- | --- |
| `web_search`，`fast` | 1.0 秒 | 8 秒 |
| `web_search`，`standard` | 1.8 秒 | 12 秒 |
| `web_search`，`deep` | 4 秒 | 25 秒 |
| `web_fetch`，一个页面 | 2 秒 | 20 秒 |
| `web_fetch`，最多 5 个页面并行 | 3 秒 | 30 秒 |
| `web_fetch`，`render` | 8 秒 | 45 秒 |

硬上限都低于 60 秒，这是 Codex 和 OpenHands 的默认工具超时。
