# 实施状态 · 2026-09-05

已实现：Phase 0–4 的插件、具名 provider、配置校验、前后台工具、prompt、独立 child bin/组合、jobs 与文档。新增用户要求：query/上轮上下文识别、UI @ 候选/引用标签、可持久化 hint、结果卡、A 接收并整合 B 结果。

## 已验证

- typecheck/build、26 项测试（配置、工具、query、UI DOM、真实组合）通过。
- `pnpm pack` 通过；产物已通过实际 `dsh plugin add` 临时 profile 安装，bundle reconciliation 与空 targets boot 成功。
- 包内默认 child YAML 独立启动与 JSON-RPC initialize 通过（未调用商业模型）。
- 真正的父 runtime 与新 child runtime，两个 provider 并行。
- jobs 注册 → job_output 收结果；A 实际回合 query → hint/tool → B → A 整合答复。
- 环境 scrub、显式 env、共享和隔离持久化、child header.cwd 正确。

## 与原设计的必要差异

1. 每个目标挂独立 SDK provider；command/cwd 不属于 start-time 请求。
2. npm 发布 API 与本地源码不同。核心使用 0.1.2-rc.1，仍支持 command/args 的 provider/client 固定 0.1.1-rc.2。弃用不兼容的旧 spine bundle，child-runtime 直接组合相同版本的核心服务。
3. 关闭共享时显式传独立 DSH_HOME，避免默认 ~/.dsh 导致串 store。
4. R2 **部分验证，UI 自动归属未实现**：同 store 与 cwd 成立；SDK provider 的父 run ID 与 child 持久化 session ID 不同，后者没有公开映射。真实 registry 挂接实验因该差异失败，最终不发布错误 ID、不展示虚假会话入口。测试固定这一限制。
5. 默认持久化使用 zstd；测试为检查 JSONL 内容显式覆盖 none。自定义父 sessions 路径或编码必须由 child 配置对齐。
6. query 识别不是独立 LLM classifier：确定性引用/名称/别名/追问匹配负责 hint，A 结合 system catalog 作语义委托决策。工具随非空配置注册。

## 待验收 / 限制

- 无浏览器连接：已测 DOM 与点击，未做实际 DSH Web 视觉验收。
- 未使用真实模型 API key；真实组合中的模型是确定性适配器。
- SDK 暴露 child session ID 后，才能可靠实现自动工作区 membership 和子会话链接。

