# workbench

本地验收 HTTP 适配器，不依赖 MCP SDK，不提供远程 MCP。`main.ts` 装配配置与运行时，`server.ts` 仅监听 127.0.0.1；默认端口 18900。

- `GET /`、`/index.html`、`/styles.css`、`/app.js`：固定静态资源。HTML 注入本次进程会话 token。
- 所有 `/api/*` 请求带 `X-Workbench-Token`；Host 必须匹配当前 loopback 地址，Origin 若存在须同源。跨站请求拒绝，无 CORS 放行。
- `POST /api/search`、`POST /api/fetch`：JSON 输入为现有工具契约，输出为直接业务 envelope，无 MCP wrapper。业务失败仍是 HTTP 200 + status=error；HTTP 边界错误为 4xx/5xx + error。
- `GET /api/status`：只读当前进程引擎观察，不主动出网。重启后状态重新 unknown。
- `GET /api/evaluation`：读取 evals/reports/latest.json，没有报告时 available=false；只展示实际保存的评估，不触发标注或采样。

每请求 64 KiB 输入、读取时限 5 秒、最多 4 个活跃工具调用。工具内部仍执行既有 deadline/网络/解析器预算。浏览器取消和服务关停传递 AbortSignal，等待请求结束后再关闭应用资源。

启动：`pnpm workbench`（先构建，读取 config/local.example.json）。更换受信配置：`node dist/workbench/main.js --config config/local.example.json --port 18901`。不在 UI 接受任意服务端文件路径或 SearXNG 端点。UI 使用方式见 [页面说明](../../ui/README.md)。
