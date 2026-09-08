# 配置

默认值在 defaults.example.json，schemas/config.schema.json 定义完整运行约束；loadConfiguration 将用户 JSON 覆盖与环境变量显式合并，再校验。

local.example.json 为本地 SearXNG 的最小覆盖配置。端点与引擎通过 SEARXNG_URL / SEARXNG_ENGINES 覆盖；存储目录通过 WEB_RESEARCH_DATA_DIR 覆盖。非法端点/引擎独立校验，不因另一字段缺失就静默忽略。

upstream_policy 为固定免 Key 准入规则，不可配置放宽；browser_fallback、模型排序等未实现选项也不能开启。调整支持的资源参数须遵守 Schema 上限及默认值/最大值关系。

SearXNG 完整本地部署配置由 deploy 模板和初始化脚本生成；随机实例 secret 保留在被 Git 忽略的 .cache/ 中。searxng-settings.fragment.yml 仅是调研时保留的 JSON 设置示意，不用于实际启动。

tsconfig.base.example.json 是设计参考；实际编译入口为根 tsconfig.json 与 tsconfig.build.json。
