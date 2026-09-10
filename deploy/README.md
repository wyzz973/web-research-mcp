# 本机 SearXNG（可选 Docker 方式）

默认推荐 [原生部署](native/README.md)，不需要 Docker。本页保留可选容器方式。

本部署提供用户自行管理的匿名搜索聚合端点，软件不需要 API Key。搜索上游可能限流、忽略查询条件或返回零结果；需要 MCP 应用层继续过滤域名并明确报告失败。

## 启动

需要 Node 24 与运行中的 Docker Compose。从项目根目录执行：

```sh
node scripts/searxng-setup.mjs
docker compose -f deploy/compose.yaml up -d --wait
curl --fail http://127.0.0.1:18888/healthz
```

端点为 `http://127.0.0.1:18888`，只发布在本机 loopback。镜像固定为 SearXNG `2026.9.8-3fdc6d753` 的 digest，见 [compose.yaml](compose.yaml)。Docker 内监听 8080 不代表宿主机对外开放。

[settings.template.yaml](settings.template.yaml) 通过 `keep_only` 移除其余默认引擎，只保留 `duckduckgo`、`bing`、`google`、`brave` 四个匿名网页适配器。实例不提供 API Key 后备，不取用浏览器账号、Cookie 或登录凭据。根据下方实测及后续波动，建议 MCP 的常用 engines 配置 `brave,google`；DuckDuckGo 与 Bing 保留用于显式对照，遇到暂停或挑战时不重试绕过。

初始化脚本把随机的 32 字节实例 secret 写到已被 `.gitignore` 排除的 `.cache/searxng/settings.yml`；目录权限为 0700，文件为 0600，secret 不输出。再次执行会保留现有 secret 并更新模板。这个 secret 是本地 SearXNG 内部签名配置，不是搜索服务的 API Key。不要提交生成文件。

## 匿名搜索检查

```sh
curl --fail --get 'http://127.0.0.1:18888/search' \
  --data-urlencode 'q=Model Context Protocol tools' \
  --data-urlencode 'engines=brave' \
  --data-urlencode 'language=en' \
  --data-urlencode 'format=json'

curl --fail --get 'http://127.0.0.1:18888/search' \
  --data-urlencode 'q=JavaScript Promise 异步 site:developer.mozilla.org' \
  --data-urlencode 'engines=brave' \
  --data-urlencode 'language=zh-CN' \
  --data-urlencode 'format=json'

curl --fail --get 'http://127.0.0.1:18888/search' \
  --data-urlencode 'q=tools structuredContent site:modelcontextprotocol.io' \
  --data-urlencode 'engines=brave' \
  --data-urlencode 'format=json'
```

检查 `results` 和 `unresponsive_engines`。HTTP 200 单独不能证明成功，`site:` 单独不能证明域名限制有效。本项目 Provider 固定发送引擎白名单并拒绝 SearXNG 引擎/直达/超时控制语法；`websearch.sites` 对每个返回 URL 强制过滤。

查看状态及停止：

```sh
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs --tail 50
docker compose -f deploy/compose.yaml down
```

容器限制为 768 MiB 内存、2 CPU、256 进程；内部单引擎请求超时 8 秒，最大 12 秒。Compose 使用 `unless-stopped`，Docker 重启后恢复已启动服务。健康检查只验证本地服务响应，外部引擎可用性需要以上搜索检查。

## 2026-09-08 本机匿名实测

在自建固定镜像内核查加载后的引擎：仅 `bing/bing`、`duckduckgo/duckduckgo`、`google/google`，全部启用；JSON 已开放、public_instance=false。没有访问公共 SearXNG 实例。

| 查询                                                 | 引擎       | 原始结果 | 耗时    | 观察                                |
| ---------------------------------------------------- | ---------- | -------- | ------- | ----------------------------------- |
| Model Context Protocol tools                         | DuckDuckGo | 10       | 1.610 s | 前两条为 MCP 官方 Tools             |
| 同上                                                 | Bing       | 10       | 1.488 s | 前两条是 3D models / 模特，偏离主题 |
| 同上                                                 | Google     | 0        | 1.018 s | 未提供引擎错误，原因未确认          |
| TypeScript 类型收窄 官方文档                         | DuckDuckGo | 10       | 1.567 s | 第一条官方 Narrowing 文档           |
| 同上                                                 | Bing       | 10       | 1.898 s | TypeScript 首页与通用教程，较宽泛   |
| 同上                                                 | Google     | 0        | 0.374 s | 未提供引擎错误，原因未确认          |
| tools structuredContent site:modelcontextprotocol.io | DuckDuckGo | 10       | 0.760 s | 2 条 URL hostname 精确等于指定域名  |
| 同上                                                 | Bing       | 10       | 0.895 s | 0 条精确域匹配，返回五金工具网站    |
| 同上                                                 | Google     | 10       | 0.458 s | 7 条精确域匹配，包含官方 Tools      |

九次 HTTP 响应均为 200，`unresponsive_engines` 均为空。以上是该时点的小样本连通性与质量观察，不是稳定成功率或排序质量基准。结果说明不能把上游 site 语法当强约束，也不能把引擎错误列表为空等同于结果相关。

### 后续波动与中文引擎对照

同日 23:00 CST 左右继续验证时，DuckDuckGo 对中文站点查询返回明确 `CAPTCHA`，随后停止请求该引擎，未清除暂停或绕过验证。Google 单独查询 TypeScript 类型收窄及 MDN Promise 中文内容均为 HTTP 200、零结果、空引擎错误列表；原因尚未确认，不能据此声称已找全内容。

在独立临时实例中，仅启用固定镜像中的 `brave` 与 `mojeek` 进行各一次查询，原有实例保持运行。已核查两个适配器元数据：`require_api_key=false`、`use_official_api=false`、`results=HTML`，没有使用 Brave Search API。

查询为 `JavaScript Promise 异步 site:developer.mozilla.org`，语言 `zh-CN`：

| 引擎            | 原始结果 | 耗时    | 引擎错误 | 观察                                                                    |
| --------------- | -------- | ------- | -------- | ----------------------------------------------------------------------- |
| Brave 网页搜索  | 20       | 1.726 s | 无       | 前四条均为 MDN 中文 Promise、Promise.all、使用 Promise、异步 JavaScript |
| Mojeek 网页搜索 | 0        | 1.375 s | 无       | 原因未确认                                                              |

这为中文场景提供了一个可用的匿名网页候选引擎，但不承诺持续成功。Brave 明确选择 `engine: brave`、`brave_category: search`；上游返回挑战时仍保留 blocked 状态。

对照完成后将 Brave 加入主模板和 18888 本地配置，保留原随机 secret，重启后确认 Healthy；实际加载引擎为上述四个匿名适配器。主实例单独查询 Brave：`MCP tools structuredContent site:modelcontextprotocol.io`、语言 `en`，HTTP 200，13 条结果，2.113 秒，空引擎错误列表。第一条为官方 Tools，后续包含 `csharp.sdk.modelcontextprotocol.io` 官方 SDK 子域。应用层默认允许子域，指定 `include_subdomains=false` 可收窄为精确 hostname。

本次配置变更后没有再次请求被挑战的 DuckDuckGo。推荐 `brave,google` 作为当前初始配置，并保留所有引擎失败诊断；免费匿名网页搜索仍可能随时变化。
