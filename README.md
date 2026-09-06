# dsh-workspace-chain

把当前请求的跨项目后续工作交给**本机另一个目录中的全新 Harness 会话**，收回结果后由当前 agent 整合答复。外部插件，不修改 Harness 本体。

## 已实现的交互

1. 输入 `@`，从 workspace-chain 候选中选择目标；输入框显示工作区引用标签，发送内容保留 `@workspace/project-b`。
2. 服务端识别当前 query 中的目标引用、名称和 `aliases`；明确的“继续／刚才那个项目”追问可关联最近六条用户消息。只分析用户消息，不把工具输出当成用户选择。
3. 注入可落日志的 hint，提醒模型结合当前请求、已有对话、目标职责与上游结果作判断。**提及一个项目不等于要求执行**；是否委托仍由 agent 判断。
4. 模型调用 `delegate_workspace`。B 是新进程、新 runtime、新 session，只接收自包含任务。
5. 前台结果直接回给 A；后台返回 job ID，由 `job_output` 收取、`job_kill` 取消。A 核对完成状态、整合结果，再回答原始请求。UI 显示目标、运行／失败／结果已返回状态和可展开的任务、结果。

工具随非空 targets 注册；query 识别控制额外 hint 的注入，不是一个独立 LLM 分类器。未被字面匹配的语义意图仍由 A 根据静态目标目录和工具说明判断。

## 安装与构建

需要 Node.js 22.16+、pnpm，以及具有 agents/tools/subagents/systemPrompt 服务的 Harness。后台需要 jobs provider 和 job tools；浏览器辅助需要 inputTriggers、slots 和 Connection。

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm pack

dsh plugin --profile <你的配置> add file:/absolute/path/dsh-workspace-chain-0.1.0.tgz
```

尚未发布到 npm。默认 bundle patch 使用空 targets，挂载后不注册委托工具、不注入 prompt；在 profile 的 `cordis.patch.yml` 中填写配置。

### 版本兼容

已验证的组合：核心运行时 `0.1.2-rc.1`，`dsh-subagent-dsh-sdk` 与 SDK client **固定 `0.1.1-rc.2`**，Web 类型包 `0.1.1-rc.2`。新 provider 已改为 profile/dshBin 接口，不能直接升级替换 command/args。仓库的 `pnpm-workspace.yaml` 固定测试依赖闭包，防止上游 prerelease 范围选到不兼容版本；用于新建测试 profile 时可复用这份约束，已有 profile 应先核对宿主版本。

## 配置

```yaml
- id: workspace-chain
  config:
    toolName: delegate_workspace
    promptEnabled: true
    defaultTimeoutMs: 300000
    shareSessionStore: true
    targets:
      project-b:
        purpose: 'Backend service: API and database work'
        aliases: [后端项目, backend]
        cwd: /absolute/path/to/project-b
        command: node
        # 路径必须可从 B 的 cwd 访问。推荐使用绝对路径。
        args: [/absolute/path/to/dsh-workspace-chain/lib/child-bin.js]
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
        provider: deepseek-official
        model: deepseek-v4-flash
        maxTokens: 8192
```

child bin 不传配置参数时使用包内 `src/child.cordis.yml`。该组合包含模型适配器、独立 agent loop、工作区指令、文件工具、shell、jobs、JSON-RPC 和会话持久化；不加载 Web UI。诊断输出到 stderr，stdout 留给 JSON-RPC。

可把自有 child YAML 的**绝对路径**作为第二个 args 元素；自有 YAML 在其所在项目解析插件依赖。显式 `DSH_CORDIS_CONFIG` 优先于命令行参数。B 的模型、工具及执行权限由 B 的组合决定；内置 shell/fs 是本地执行器，若需要沙箱或审批，请提供相应 child 组合。

目标 cwd 在加载时 realpath 校验，调用时复查。缺失 cwd/command、文件路径冒充目录、无效 timeout/env 均报配置错误。工具只接受目标名字和 task，不能指定任意目录、命令或环境变量。相对 cwd 在父进程加载时解析；command/args 按子进程执行语义解析。

## Store 策略

- `shareSessionStore: true`：显式传父侧解析后的 `DSH_HOME`，B 写入同一个 sessions 根目录；冲突的目标 `DSH_HOME` 会被拒绝。
- `false`：默认使用 `<目标 cwd>/.dsh-workspace-chain`，也可显式配置不同于父 home 的 `env.DSH_HOME`。**仅省略 DSH_HOME 无法隔离**，因为会回落到 `~/.dsh`。
- 内置持久化默认 zstd，与 Harness base 对齐。若父组合使用 `compression: none` 或自定义 sessions 根目录，child 配置必须显式对齐；共享 DSH_HOME 不会自动复制父组合。
- 环境继承由 SDK provider 的 `scrubbedParentEnv()` 完成。凭据和 `DSH_*` 默认清除；需要的值通过 target.env 显式传入。UI catalog 不包含 cwd、command、args 或 env。

**当前限制：同 store + 正确 cwd 已实测，但不会自动挂接父 UI 的工作区会话列表。** 当前 provider 的 `run.id` 是父侧运行 ID，和 B 的持久化 session ID 不同，且没有暴露二者映射。因此结果卡只展示结果和后台 job ID，不提供会跳错的子会话链接，也不伪造 workspace membership。修复需要 provider 暴露真实 child session identity；本插件没有新增旁路传输。

## 工具与后处理

参数：`target: string`、`task: string`、`run_in_background?: boolean`。task 应含相关上游结果、目标文件、预期行为和验收标准；不复制 A 的全部历史。

前台成功的规范值包含 `{ kind: 'foreground', runId, output }`，模型读到 B 的最终文本；非 completed 的 stop reason 返回工具错误，保留 diagnostic 和 partial output。完成与失败均等待 dispose。后台使用 parent-owned jobs，成功输出经 `job_output` 返回；取消和超时传递到 provider，清理失败不会被当成成功。

后处理是现有 agent loop 的工具结果回流，加上 prompt/hint 中的核对、整合要求；没有另起一个模型改写器，也没有 turn 结束后自动触发下一次委托。这样返回结果不会自行形成无限工作区链。

## Model Experience

- 非空 targets 增加一个三参数工具；目标名列表随配置增长。空 targets 成本为零。
- 静态 system prompt 列出目标名称与 purpose，配置不变时文本稳定，保持前缀缓存稳定。
- 命中 query 时追加短 hint，并通过现有 `agent/pre-step` → `user/message` 路径持久化；它只影响当前新增上下文，不重写历史。
- UI 不注入隐藏命令，引用的剪贴板文本与发送文本一致。
- 子任务每次完整启动 runtime，有启动成本；独立任务可以并行。没有进程池、常驻实例、远程传输、结构化输出或跨进程 persona/toolFilter 强制策略。

## 验证

`pnpm test` 包含配置／工具／query／UI DOM 测试，以及真实 Cordis + SDK 子进程组合测试（仅模型使用确定性 fixture，无需 API key）：多个目标并行、前后台结果、A 的实际模型请求中的 hint/tool、A 整合结果、凭据清洗、共享／隔离会话落盘、父持久化服务重新发现 child headers，以及 run ID 与 child ID 不同的回归断言。

`node scripts/smoke-install.mjs <tgz>` 在临时 DSH_HOME 中通过实际 `dsh plugin add` 安装包、验证 bundle 挂载，并 boot 空 targets。仅使用缓存时会带 `--offline`，不修改个人 profile。

浏览器辅助通过 DOM 渲染和点击行为测试；当前执行环境未连接浏览器，尚未完成真实 DSH Web 页面视觉验收。真实商业模型调用未执行。
