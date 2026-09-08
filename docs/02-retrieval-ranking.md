# 适配 LLM 的检索、召回与排序

## 先明确可控制的层次

外部引擎负责全网索引和第一阶段召回。本项目能控制查询改写、选择来源、合并候选、抓取正文和证据段落排序。没有返回的 URL 不会因为使用 reranker 就自动出现。

已抓取页面构成本地语料后，才可以对这些页面使用 BM25、向量检索或混合召回。搜索结果中的 snippet 是上游摘要，不能等同于已验证的网页正文。

## 算法地图

| 方法 | 作用 | 适用与局限 | 优先级 |
| --- | --- | --- | --- |
| 查询规范化与规则扩展 | 保留实体、版本、错误码，必要时加站点条件 | 简单可控；不要删掉负向约束或数字 | M1 |
| 多查询 / 多来源召回 | 原查询加中英文变体或子问题，扩大候选并集 | 请求成本上涨；近似查询和共享上游不算独立证据 | M3 |
| BM25 | 按词频、逆文档频率与长度归一化进行词项匹配 | 专有名词、代码、错误码有效；同义和跨语言弱 | 本地召回基线 |
| Dense embedding + cosine/dot | 语义向量相似检索 | 可补同义表达，精确数字和否定关系仍需验证 | 可选 |
| HNSW | 在大向量集合中近似寻找邻居 | 是向量候选搜索结构，不是真实性或权威性排序模型；有召回率/内存/延迟取舍 | 语料扩大后 |
| SPLADE | 学习式稀疏扩展，连接语义扩展与词项检索 | 需要模型和稀疏索引，增加部署成本 | 后续研究 |
| RRF | 根据多个列表的名次融合 | 无需跨引擎原始分数可比；仍需处理来源相关性 | 有多列表后 |
| Cross-encoder reranker | 联合阅读 query 与候选文本，精排相关性 | 比双塔更贵；不能判断事实已核实 | 小候选集可选 |
| MMR | 在相关性与已选文本相似度之间取舍 | 降低重复，可能损失最相关的同域结果 | 证据选择阶段 |
| ColBERT | token 级后交互匹配 | 更细粒度，索引存储和服务复杂度更高 | 暂缓 |
| LambdaMART / Learning to Rank | 用标注学习多特征排序 | 需要可靠相关性标签，点击位置偏差不可直接当真值 | 有数据后 |
| HyDE | 生成假想文档再作向量召回 | 假想内容只用于查询，不得写入来源证据；需生成模型 | 默认关闭 |

方法依据：[BM25](https://nlp.stanford.edu/IR-book/html/htmledition/okapi-bm25-a-non-binary-model-1.html)、[HNSW](https://arxiv.org/abs/1603.09320)、[SPLADE](https://arxiv.org/abs/2107.05720)、[RRF 原论文](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)、[Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)、[MMR 原论文](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf)、[ColBERT](https://arxiv.org/abs/2004.12832)、[LambdaMART](https://www.microsoft.com/en-us/research/publication/from-ranknet-to-lambdarank-to-lambdamart-an-overview/)、[HyDE](https://arxiv.org/abs/2212.10496)。优先级为本项目设计判断。

## 推荐演进顺序

M1：规范化 sites/域范围 → 原查询与上游 site 策略 → SearXNG → 强制域过滤与 URL 去重 → 保留原排名 → 附词法相关性解释。

M2：显式证据搜索或独立 fetch → 正文结构化 → 不可变快照 → 连续原文证据与续读、可追溯置信等级。

M3：多个明确标识的来源列表 → 去重 → RRF → BM25/可选向量段落召回 → 可选精排 → 多样性选择 → 带定位的证据片段。

当前 relevance/ confidence 的字段、计算方法与等级规则由 [站点与证据设计](12-sites-evidence-scoring.md) 维护。M1/M2 的词法分值是解释性基线；M3 更换算法必须更新评分方法和版本，不能复用字段名暗中改变分数含义。

第一版不要重算或伪造 SearXNG 已聚合列表中各引擎的原始排名。若只获得一个聚合列表，直接保留其顺序；只有能取得每个真实列表及 rank 时才实施跨来源融合。

### RRF

本项目候选公式（标准 RRF 加可配置权重）：

```text
score(d) = Σ_list w_list / (k + rank_list(d))
```

rank 从 1 开始；缺失候选贡献 0；同一列表内同一 URL 只计一次。先用等权与 k=60 作实验起点，绝不把这个常数当作普适最优。合并相同 URL 时保存所有出现来源；对同一上游的镜像 Provider 或高度重复查询设组权重上限，避免多注册适配器就刷高排名。

RRF 分数仅用于候选排序，不是相关概率、可信度或事实置信度。需要消融对照，不承诺一定胜过单引擎原排序。

### BM25 与中文

采用 BM25 作为便宜且可解释的本地基线，标题和正文可配置权重。SQLite FTS5 内置 bm25 返回值方向与许多库不同，通常数值越小越好，接入时需显式归一化排序方向。[FTS5](https://www.sqlite.org/fts5.html)

FTS5 默认 unicode61 将连续文字视为词项；据此推断，不能把它直接视为中文语义分词器。索引和查询使用同一中文分词版本，另保留英文标识符、版本号、原文 offsets。可用字符 n-gram 作实验对照；三元组不适合所有短中文词，不能直接代替分词。

### 精排与证据选择

先在较小候选集上比较本地 `BAAI/bge-reranker-v2-m3`；模型卡声明支持多语言，实际中文效果、CPU 延迟和内存仍需本机测试。[模型卡](https://huggingface.co/BAAI/bge-reranker-v2-m3)

精排输入优先为标题和实际提取段落；仅有搜索摘要时标明 evidence_level=search_snippet。先拆段再精排，避免长文前缀截断遗漏关键内容。选中的段落按文档顺序展示，并保留标题层级、代码块和必要邻接段落。

MMR 可采用：

```text
next = argmax_d [λ × relevance(q,d) − (1−λ) × max_s similarity(d,s)]
```

第一段按 relevance 选取，后续计算与已选段落的相似度；两个分数需匹配量纲或归一化。λ=0.7 仅作初始对照参数。来源域多样性可作软约束，但用户明确 site: 查询时不能强制跨域。

权威性与新鲜度只是可解释特征：记录一手来源、发布日期的解析出处；缺失日期保持 null，不把抓取时间写成发布日期。没有网页链接图就不要声称实现了全网 PageRank。

## 面向 LLM 的输出原则

- 来源身份与内容版本分离：URL 对应 source_id，提取内容对应 snapshot_id。
- 保留原 URL、最终 URL、抓取时间、提取器版本与内容哈希。
- Markdown 是显示层，结构化段落是定位层；不执行原网页脚本和指令。
- 默认不生成摘要；后续若增加模型摘要，必须与原文摘录分开标识。
- 有字符预算就标明字符预算，不按字符数/4 伪称精确 token 计数；真正 token 预算需配置 tokenizer。
- 正文被截断时可读后续同一快照；提取失败和无结果必须可区分。

## 评估方法

用 BEIR 的跨领域评估思路设计自己的中英文查询集；其结果说明 BM25 是值得保留的基线，不能由此推断某算法在本项目必胜。[BEIR](https://arxiv.org/abs/2104.08663)

检索看 pooled Recall@20、nDCG@10、MRR@10；网页获取看有效正文成功率、代码/表格保真、p50/p95 延迟；LLM 使用看引用覆盖和摘录可定位比例。网络级全网 Recall 无法直接知道，必须标注为对标注候选池的召回率。具体评估表见实施文档。
