# 共享模型与规则

types.ts 定义业务接口，errors.ts 定义操作失败和取消，contracts.ts 在 JSON 边界使用作者 Schema 校验。config.ts 只在启动解析默认值、覆盖文件和显式环境；domain-scope.ts 与 search-policy.ts 维护域范围和免 Key 引擎准入。
