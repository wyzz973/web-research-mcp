# 共享模型与规则

types.ts 定义业务接口，errors.ts 定义操作失败和取消，contracts.ts 在 JSON 边界使用作者 Schema 校验。config.ts 只在启动解析默认值、覆盖文件和显式环境；domain-scope.ts 与 search-policy.ts 维护域范围和免 Key 引擎准入。

`trace.ts` 定义可选 `TraceRecorder` / `TraceStore` 接口及 AsyncLocalStorage 记录器，不导入存储或网络实现。依赖由 runtime 显式注入；`run` 创建服务端随机 trace ID，`client_request_id` 仅用于浏览器发起与列表轮询的相关联，最终工具 `request_id` 单独保存。每个并发异步分支保留自己的父 span；无 run 上下文的 span 直接执行业务函数。业务返回 error/partial 与抛出取消分别记录，诊断写入失败不改变业务结果。

默认只保存有界元数据：查询/标题/正文显示字符数，URL 只显示 origin。显式 `captureContent` 可对单个 run 保存最多 2,000 字符 JSON 预览，并沿用至子 span；即使开启仍屏蔽 headers、Cookie、token、cursor、凭据字段、URL 用户信息/查询参数/fragment。记录器不执行对象 getter，也不序列化非 JSON 实例。每 run 最多 200 span、256 KiB，超过限制标记 `truncated`，后续业务仍照常运行。

诊断库首次写入失败会调用可选 `onError()` 一次，runtime 可据此公开 `storage_unavailable`；异常详情不会传给回调，回调自身失败也不影响业务。已知 checksum、content type、提取器版本和错误码属于默认可见元数据，不会因为名称带 content 而被当成正文隐藏。
