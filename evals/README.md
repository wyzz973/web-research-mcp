# 可复现搜索评估

本目录保存查询目录、冻结的真实候选池、相关性标注和离线报告。文件存在不等于完成所有验证；以报告 coverage、assessor 和逐查询状态为准。

- `queries.json`：56 条查询，英文与中文各 28 条，覆盖精确实体、概念、错误码、版本、时效、对比、短词、限定站点。时效问题的语境日期固定为 2026-09-10。
- `pools/qNNN.json`：真实 MCP 采样后导出的标题/摘要/URL、上游顺序、时间、运行版本、响应 SHA256 和证据完成计数。原始 payload、游标和正文快照保留在本地 artifacts，不进入公共报告。
- `judgments/qNNN.json`：0 不相关；1 相关但不足以直接回答；2 标题/摘要明确针对查询。assessor.kind 必须区分 human 和 agent；本轮 agent 标注只是可复现的初步审阅，不是人工金标。
- `reports/latest.json`：在相同池上比较 upstream、bm25、bm25_mmr；保存顺序、指标、计时和覆盖缺口。

## 运行

需要 Node 24，依赖安装完成，并先 `pnpm build`。离线评估不出网：

```sh
node scripts/evaluate.mjs
```

默认写入 `evals/reports/latest.json`；`--pools`、`--judgments`、`--out` 可指定独立实验目录。输入通过严格 Schema 校验，未知字段、标注 ID 缺失/重复、池哈希不符会失败。无标注保持 null，不自动把未标注当不相关。池中完全没有相关结果时，指标保持 null，并保留该查询的覆盖记录。

明确发起真实采样（默认仅 3 条，每次调用后至少间隔 15 秒）：

```sh
node scripts/collect-eval.mjs --out artifacts/my-evaluation
node scripts/collect-eval.mjs --limit 56 --interval-ms 20000 --out artifacts/my-full-evaluation
node scripts/freeze-eval.mjs artifacts/my-full-evaluation
```

默认使用 `config/local.example.json`，可用 `--config` 指定；上游继续是自己运行的免 Key SearXNG。`--offset` 用于从查询目录某个位置继续，单次最多 56 条。每条调用限 65 秒，不自动重试验证码或更换上游；每条最多返回 10 条候选，最多补抓一个来源。每次响应单独落盘，错误也留档；输出存在则拒绝覆盖。SIGINT/SIGTERM 取消在途 MCP 调用并关闭子进程，采样进度可保留。

freeze 核对原始响应 SHA256 后导出有界字段；原记录不应公开，因为含完整搜索文本、原文和本地游标。freeze 对已有完全一致的池幂等，对不同内容拒绝覆盖。变更候选池须使用新实验目录和重新标注；不能沿用旧池标签。

## 标注与解释

标注必须逐条审阅整个候选池，并记录判定理由、日期、评判者 ID、依据（title_snippet 或 fetched_document）。`pool_sha256` 是 `sha256(JSON.stringify(pool))`，不是原始响应哈希。自动采集器不生成相关性分数或标签。按标题/摘要判定只能用于发现排序；不能证明正文支持、事实真假或发布时间正确。

nDCG@10 使用 gain=2^grade-1 和 log2(rank+1) 折扣；MRR@10 将 grade>0 视为相关；pooled Recall@20 的分母是该冻结池全部 grade>0 的候选数。它不是全网召回率。本轮最多 10 候选，Recall@20 对有相关项的完整池必然为 1，不具有区分排序方案的能力；后续需扩大真实候选池并补充完整标签。此限制不能通过虚构未召回网页修补。

汇总仅包含完整标注且至少有一个相关项的查询；同时报告采样总数、未采样查询、失败/partial/empty 和已标注数量。不得只挑成功查询声称服务可用率。真实请求耗时含证据抓取；本地排序计时仅一次、非压力基准。RRF 函数存在，但本轮没有独立引擎列表，报告明确不运行 RRF。

## 资源和发布门槛

BM25 使用标题+摘要，k1=1.2、b=0.75，Intl.Segmenter/NFKC 分词；MMR λ=0.75，以词集 Jaccard 抑制重复。两者只重排候选、不删除来源，平分保留上游名次。返回的内部 BM25 分数不是原有 lexical relevance，也不是置信度或事实概率。

最多 200 候选，每条标题+摘要合计 12,000 Unicode code points，查询最多 2,000；超额拒绝。词法分词总输入最多约 240 万字符，MMR 最多约 20,000 次成对相似度比较；无网络、无模型下载。运行版本记录 Node/ICU，换版本应重新比较。大文本上限是防护边界，不代表所有机器上都达到特定延迟 SLA。默认继续上游顺序；可选实验模式无需宣称已获得普遍收益。

单元和 CLI 反例测试见 [retrieval-evaluation.spec.ts](../tests/retrieval-evaluation.spec.ts) 和 [evaluation-cli.spec.ts](../tests/evaluation-cli.spec.ts)。冻结 live 结果与 synthetic 测试数据严格分开；一般 CI 可复算冻结数据，不依赖当时的免费搜索可用性。

## 本轮结果的边界

报告额外提供 nDCG@5 与 pooled Recall@5，便于在 Top10 池内观察头部排序差异；MRR 和 Recall@20 可能饱和。所有初始审阅人都是 Codex 子任务（root、quality_ranking、engine_health），日期和身份按文件记录；尚未完成人类交叉复核。不要用这些标签训练一个模型，再在同一批标签上宣称独立泛化收益。

2026-09-10 合成资源探测（独立于相关性评估）在 Node 24.20.0/macOS 上：80 候选约 69 万字符的 BM25+MMR 单次约 85ms；200 候选约 186 万字符单次约 425ms，进程累计峰值 RSS 约 245MiB。这不是并发测试或 p95 SLA，机器与文本结构不同会变化。真实 Top10 短摘要池的排序耗时记录在报告中。

本轮 live 录制使用启动时加载的 0.2.1 MCP 与 `config/local.example.json`（其排序保持默认 upstream），原始 input 没有 ranking_mode，旧响应也没有 ranking 元数据；不改写旧 payload。新采集器显式传 ranking_mode=upstream，freeze 拒绝显式非 upstream 输入或非 upstream 返回排名，并核对输入/响应查询和状态一致。旧版缺失排名元数据只能在确认采样配置后作为基线使用，这项历史假设不等于哈希能证明上游顺序。P0 新健康诊断的最终联网验证须另列，不能拿这批稳定旧进程的采样冒充新代码运行证明。
