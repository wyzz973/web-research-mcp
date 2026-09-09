# 段落证据与前端来源展示

版本：0.2.0；业务契约：0.3-draft。此页维护新增字段和展示语义，通用工具规则见 [工具契约](04-tool-contracts.md)。

## 更完整的原文

证据按完整段落选择，并尽量保留标题、前后解释、条件和例子。单个软换行不再被当成句末。相邻窗口在预算内合并，重复/重叠范围不重复返回；稀有查询词与未覆盖查询词影响选段优先级，public relevance 仍是原来的词法覆盖分值，不偷换评分含义。

默认每条结果最多 3 段、每段最多 1,600 Unicode code points、合计最多 4,000 字符（预算包括展示时段间分隔符）。部署者可调整到最多 5 段、每段 2,000、每结果 8,000；候选选段默认最多 32，硬上限 64。不是最低字数承诺，短页面或证据不足不以无关内容凑数。

quote 始终等于保存的 text 快照中的连续子串。跨段证据新增 segment_ids，按文档顺序列出全部覆盖段落；原 segment_id 保留为第一个覆盖段落。selection_method 固定为 paragraph_context_v2，字符位置与完整内容 SHA-256 继续返回。

## 更多相关证据

每条搜索结果新增以下字段：

| 字段 | 含义 |
| --- | --- |
| evidence_chars | 本页所有 quote 的字符数之和，不含展示分隔符 |
| has_more_evidence | 冻结的相关选段计划中是否还存在未返回项 |
| next_evidence_cursor | 读取下一页相关证据的 opaque cursor；没有剩余时为 null |

将 next_evidence_cursor 传给现有 webfetch 的 cursor 参数：

```json
{"cursor":"ACTUAL_NEXT_EVIDENCE_CURSOR","format":"text"}
```

返回 view=evidence，evidence 数组包含新段落；content 是这些原文片段以空行连接的展示文本，**不是连续完整文档**。segments 的偏移仍对应原始完整快照；content_sha256 也对应完整快照，不对应当前展示拼接串。next_cursor 是 next_evidence_cursor 的同值便利入口，truncated 表示计划仍有证据。

普通 URL 或 evidence[].snapshot_cursor 返回 view=document。它们仍按连续文档分页，evidence 数组为空；若想看整篇原文，应使用 snapshot_cursor。两种视图都返回 source_metadata，不依赖前端记住搜索会话。

证据候选计划单独持久化，cursor 只保存计划身份和偏移；重启、重复读取不重新请求网页。max_chars 不能扩大冻结计划或当前部署上限，分隔符也计入总预算；如果下一段完整原文无法装入请求预算，明确报错，不能截成半句或跳过该段。过期、格式不符或计划/快照不一致明确失败。

has_more_evidence 仅针对已经选择并冻结的候选计划。候选数达到上限时返回相应 warning，不声称覆盖了网页中的所有可能证据。

## 前端来源字段

source_metadata 在搜索每个结果以及 webfetch 成功结果中返回。字段以 [作者 Schema](../schemas/source-metadata.schema.json) 为准，并自动内联至两个 MCP outputSchema，客户端不需要解析仓库相对 $ref。

| 字段 | 来源与展示用途 |
| --- | --- |
| site_name | 优先网页 og:site_name，其次 application-name，最后 hostname |
| hostname / domain / origin | 从实际 URL 解析的主机、可注册域和 origin，用于显示真实来源 |
| display_url | URL 的主机、路径及查询部分，用于紧凑显示 |
| source_url | 实际请求的原始 URL；不被 canonical 替换 |
| final_url | 实际获取后的最终 URL；尚未获取为 null |
| canonical_url | 网页声明的 canonical，仅作声明保留，不影响域检查、来源身份或抓取地址 |
| favicon_url | 实际 link icon/apple-touch-icon；没有声明时可为 origin/favicon.ico 候选 |
| logo_url | 站点/发布者 JSON-LD 声明的 logo；未识别为 null |
| image_url | Open Graph 页面预览图，与网站 logo 分开 |
| description / language | 网页简述与语言声明，未取得为 null |
| published_at / modified_at | 可解析的网页日期声明；非法日期不猜测 |
| retrieved_at | 本次实际获取时间，续读不刷新这个时间 |
| metadata_source / metadata_url | url_only 或 html，以及实际读取元数据的页面 |
| provenance | 站名、图标、logo、图片和 canonical 分别来自何种声明/后备 |
| assets_verified | 本版固定 false：只返回资源 URL，没有下载图片或验证其可用性 |

图片 URL 的来源标记可为 html_link、json_ld、opengraph、origin_fallback 或 none。favicon 的后备地址只是约定地址，可能返回 404；logo_url 缺失不能拿 og:image 或搜索摘要图片冒充。

没有开启原文获取，或该结果未在补抓预算内时，不会额外抓每个网站寻找图标。此时 metadata_source=url_only，站名由域名派生、favicon 明确为候选、logo/image/canonical 为 null。开启 evidence_mode=extract 后，被实际读取的结果才获得网页声明。

## 展示与溯源边界

网站声明不是身份认证。前端应同时显示实际 hostname，不能仅凭 site_name/logo 判断可信性。favicon 和 logo 可正常引用第三方 CDN，但 source_url/final_url/metadata_url 必须保持实际来源。canonical 不改变来源或允许域范围。

返回前过滤非 HTTP(S)、userinfo、字面私网地址和本机域名，不下载图标、不请求第三方 favicon 服务、不查询图标 DNS。前端把文本作为文本渲染；图片失败时回退到域名字母。若服务端代理图片，应在代理的每次 DNS、连接和跳转时重新执行出网策略；不能只信任返回的 URL。建议前端图片使用 no-referrer，避免携带当前页面地址。

完整元数据保存到 SQLite 快照，读取时验证 Schema 和实际来源归属；旧快照没有该可选字段时仍能读，展示层明确采用 url_only 后备，不伪装成新 HTML 观察。SQL user_version 不变。旧搜索池版本被新契约明确拒绝，用户需重新搜索；旧普通文档游标仍可续读。

语义依据：[Open Graph](https://ogp.me/)、[Schema.org logo](https://schema.org/logo)、[HTML rel=icon](https://html.spec.whatwg.org/multipage/links.html#rel-icon)。
