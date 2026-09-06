# dsh-workspace-chain 设计与实施计划

状态：首版已实施，验证与差异见 [status.md](status.md)；R2 的父 UI 自动归属仍受 provider identity 契约限制。交付位置：`dsh-plugins/dsh-workspace-chain`（新插件仓库，与
`dsh-enhanced-workspace` / `dsh-remote` 同形态的外部插件）。

## 1. 背景与目标

场景：chat 步骤中需要多项目联通。会话 **A**（工作区 W1）在完成任务后，把一个 task
交给**另一个工作区 W2** 的 agent 会话 **B** 处理：B 是全新的会话、完整的 dsh agent
（自己的系统提示 / 工具集 / 会话持久化），处理完把结果送回 A。

已确认的决策（2026-09-05 与用户敲定）：

1. **目标形态**：同机另一项目目录，每次调用**新起一个 harness 子进程**（B = 子进程里的全新
   runtime + 新 session）。不做"连接已常驻 dsh 实例"，不做远程机器（后者留给未来与
   `dsh-remote` 组合）。
2. **触发语义**：模型驱动 —— 插件给 A 注入一段 prompt 指令 + 一个 `delegate_workspace`
   工具，A 在任务完成时作为最后一步调用该工具（同步等结果，或后台 job）。
3. **交付位置**：dsh-plugins 下新建独立插件仓库，不修改 DeepSeek Harness 本体。

核心依据（已在 deepseek-harness 源码中核实）：

- harness 的 subagent capability seam（`ctx.subagents`）**已内置两个 out-of-process
  provider**：`dsh-subagent-dsh-sdk`（spawn 完整 harness 子进程，stdio JSON-RPC 驱动，
  `cwd` 可配置 → 子进程的 workspace cwd）和 `dsh-subagent-acp`（驱动任意 ACP agent）。
  B 的"全新完整 runtime + 新 session"语义**现成**。
- 模型侧 Consumer（`dsh-tool-subagent`）现成：给 A 加一个工具、绑定 provider，含
  foreground / background(`ctx.jobs` Task) / continuable 三种模式。
- 结论：**本插件不实现委托传输，只做传输之上的一层**：具名目标注册表、模型面工具契约、
  prompt 注入、配置校验、共享 store 策略。真正的空白只有子进程 child bin（A 侧要有一个可
  spawn 的"B 运行时入口"）。

## 2. 架构

```text
A 会话（工作区 W1, 宿主 dsh 进程）
  └─ turn: 模型调用 delegate_workspace(target, task [, run_in_background])
       └─ 本插件 tool handler
            ├─ 解析 targets[target]（未知 → fail loud 工具错误）
            ├─ 校验 cwd 存在（realpath, load 时已校验一次）
            └─ ctx.subagents.start('dsh-sdk', { parent, prompt, signal })
                 └─ dsh-subagent-dsh-sdk provider
                      └─ spawn 子进程: <command> <args>（child bin + child cordis.yml）
                           ├─ 子进程 cwd = 目标工作区目录
                           ├─ 子进程 env = 父 env 清洗后 + config.env（DSH_HOME /
                           │    DEEPSEEK_API_KEY 显式传入）
                           └─ 子进程内: 全新 session B（session/prompt 一条 user 消息）
                                → B 完整跑完（自己的模型/工具/额度）
                                → 结果（最后一条 assistant/message）经 JSON-RPC 回传
       └─ tool 结果 = B 的最终输出（或后台 jobId）
```

不修改 harness 本体：全部走 `ctx.subagents`（provider 注册已在 `dsh-subagent-dsh-sdk`
包里）+ `ctx.tools`（本插件注册自己的工具）+ system-prompt 截面（注入提示段）。

## 3. 为什么新建插件，而不是基于 dsh-enhanced-workspace

`dsh-enhanced-workspace` 是**纯客户端 UI 插件**（侧边栏 Workspace Browser v2：最近工作区、
目录树、拖拽、Hover 卡片），无任何服务端 agent 逻辑，与本链路没有可复用代码。把委托塞进它
是跨域污染（一个事实一个归属）。`dsh-remote`（SSH 远程工作区）是未来的组合对象而非基座：
本插件 v1 只做同机目录，不依赖它。

## 4. 设计

### 4.1 插件形态

- 函数插件（无 default export —— 见 harness postmortem 0001：default export 会让 cordis
  loader 丢弃 named export 的 `inject` 元数据）。
- `inject`: 至少 `['agents']`（拿到调用者 Agent 作为 `ctx.subagents.start` 的 `parent`）；
  后台模式需要 `jobs`（dsh-jobs 的 Task 注册，与 `dsh-tool-subagent` 的 one-shot 后台路由同款）。
- peerDependencies（实现时按实际引入定）：`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-subagent`（类型 + 运行时服务）、`@deepseek-ai/dsh-jobs`（后台模式）。
  均为 npm 发布包；依赖版本以 `dsh plugin add` 能解析为准（实现时先 `pnpm view` 验证）。
- 挂载：`dsh.plugin.json` + `cordis.patch.yml`（`dsh.bundle.patch`），
  `dsh plugin --profile <name> add dsh-workspace-chain`。

### 4.2 配置（cordis.patch.yml）

```yaml
- id: workspace-chain
  name: dsh-workspace-chain
  config:
    toolName: delegate_workspace
    promptEnabled: true                    # 是否注入 4.4 的提示段
    defaultTimeoutMs: 300000               # 单次委托上限（走 AbortSignal.timeout）
    shareSessionStore: true                # 子进程 DSH_HOME = 父 DSH_HOME（见 4.6）
    targets:
      project-b:
        purpose: 'backend service B; handles API tasks'
        cwd: /Users/havoc/Projects/project-b   # 目标工作区目录
        command: node
        args: ['./node_modules/dsh-workspace-chain/lib/child-bin.js', './child.cordis.yml']
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
      project-c:
        purpose: 'docs site'
        cwd: /Users/havoc/Projects/project-c
        command: ...
        args: ...
```

规则：

- `targets` 为空 → 插件挂载但工具不注册、prompt 段不注入（安静退化，因为"没有目标"是合法
  配置）；`targets` 存在但某条目缺 `cwd`/`command` → **load 时 fail loud**。
- `cwd` 在 load 时校验：存在且为目录（realpath），失败 fail loud（自包含配置，最早可解点）。
  调用时再查一次（目录可能随后消失 → 工具错误，不是崩溃）。
- 工具只接受 `target` 名字，**不接收路径/命令** —— allowlist 语义，模型无法自由指定目标。
- 目标是"目录"，不是 workspace 注册记录（`ctx.workspaceRegistry` 在 headless 宿主里可能不
  在；子进程是独立 runtime，其 workspace 归属由子进程自己按 cwd 建立）。目录存在性 = 目标
  有效性的判据。

### 4.3 工具契约（`delegate_workspace`）

Schema（模型面，语言用英文，措辞从模型视角写）：

```jsonc
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Name of the target workspace agent to delegate to (configured targets: <targets 名列表，实现时由配置生成>)."
    },
    "task": {
      "type": "string",
      "description": "Standalone, self-contained task for the target agent. The target is a fresh session with no knowledge of this conversation, so include all context it needs (files, goals, acceptance criteria)."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Start the delegation as a background job and return a job id immediately; collect the result with job_output. Default false: wait for the target to finish and return its final output."
    }
  },
  "required": ["target", "task"]
}
```

行为：

- `target` 未知 → 错误工具结果（列出可用目标名），不 spawn。
- prompt 组装：`task` 作为 child 的 user 消息（dsh-sdk provider 契约：child 是全新会话，
  `inheritsParentContext: false`），不携带 A 的历史。
- 前台：await `run.result`，然后必 `await run.dispose()`；`stopReason === 'completed'` →
  返回 child 最终输出文本；非 completed → `isError` 工具结果（headline = stop reason +
  provider diagnostic + 保留的部分输出）。
- 后台：经 `ctx.jobs` 注册 parent-owned Task，返回 `{ jobId }`，后续 `job_output` /
  `job_kill` 收结果（复用全局 job 表面，不新造渠道）。
- 取消：exec.signal（前台含 `defaultTimeoutMs` 超时）透传为 `SubagentStartRequest.signal`。
- 并发：同一消息内多个 `delegate_workspace` 并行调用天然成立（dsh-sdk provider 支持并发
  start；各自独立运行）。

### 4.4 Prompt 注入段

`promptEnabled: true` 时注册一个 system-prompt 段（如 `deployment:workspace-chain`）：

- 列出配置的目标（name + purpose），一句话规则："当你当前任务的后续工作属于目标 X 时，在
  收尾前调用 `delegate_workspace`，把后续任务以自包含描述交给 X；可以并行发起多个委托"。
- 段随 targets 配置静态生成（无动态插值），KV-cache 前缀稳定。
- 内容保持简短（几句话），模型面只出现任务相关概念。

### 4.5 子进程侧（B 的运行时入口）

本插件需要自带一个可 spawn 的 child bin + 一份默认 child cordis.yml（形状参考 harness
`packages/examples/jsonrpc-demo`：`jsonrpc` server + `dsh-sdk-jsonrpc-server` + base
工具集 + session 持久化，无 Web UI）：

- `src/child-bin.ts`：boot 指定 cordis.yml 的最小 bin（参考
  `packages/examples/jsonrpc-demo/src/bin.ts`），stdout 只走 JSON-RPC（`jsonrpc` 插件在
  stdio），诊断走 stderr。
- `child.cordis.yml`（插件内默认模板，允许 targets 条目用 `command/args` 覆盖为项目自己的
  组合）：headless 风格 —— dsh-base 层 + jsonrpc + 模型路由 + fs/shell/tools 等基础能力。
  B 的模型/工具集/额度由该 child 组合决定（这正是特性：B 可以配自己的上下文）。
- `env`：子进程环境 = `dsh-subprocess` 的 `scrubbedParentEnv()`（环境变量名带凭据形状和
  `DSH_*` 被剔除）+ `targets.<name>.env` 显式合并。因此 `DEEPSEEK_API_KEY`（或走子进程自己
  的 credentials 配置）和 `DSH_HOME` 都必须显式传（见 4.6）。

### 4.6 会话落盘与 UI 可见性（shareSessionStore）

- `shareSessionStore: true`（默认）：`env` 里显式传 `DSH_HOME` = 父进程的 DSH_HOME →
  子进程 B 的 session 持久化写到**同一个 store**；按 cwd（= 目标工作区目录）归属，B 的会话
  会出现在父进程 UI 的**该工作区会话列表**里。产品效果正是"A 看到的另一个 workspace 里的
  新 session B"。
- `shareSessionStore: false`：不传 DSH_HOME（或传独立值）→ B 的 session 与 A 完全隔离。
- 实现时**必须实测验证** scrub 行为与 workspace bootstrap 时序（风险项 R1/R2）。

### 4.7 事件与日志合规（harness 规则）

- 前台委托：模型可见内容 = 工具调用参数 + 工具结果，已是 `tool/call` / `tool/result`
  会话事件，天然满足"model-visible ⟺ logged"，**不新增 SessionEventMap 类型**。
- 后台委托：job 注册/结果经 dsh-jobs 现有事件。
- 不做"turn 结束后自动触发"（那是事件驱动变体，v1 明确不包含，避免引入新的落 log 语义）。

### 4.8 安全

- 目标 allowlist（config targets）+ 工具不收路径/命令 → 减少任意目录执行面。
- 子进程 env 清洗（父的凭据/DSH_* 默认不泄漏）。
- 需要人工确认的部署可走 harness 现有 tools/* 审批策略（permission preset 对
  `delegate_workspace` 设审批）；v1 不做定制审批 UI。

## 5. 仓库形态（dsh-plugins/dsh-workspace-chain）

```
package.json              # dsh.bundle.patch → cordis.patch.yml；files 收敛
cordis.patch.yml          # 4.2 配置（含示例 targets）
dsh.plugin.json           # 插件元数据（client 无）
tsconfig.json / tsconfig.build.json / tsdown.config.ts   # 参考 enhanced-workspace 的构建
src/
  index.ts                # 函数插件：name/inject/Config/apply（无 default export）
  config.ts               # targets 校验（load 时 fail loud）
  tool.ts                 # delegate_workspace 注册与 handler
  prompt.ts               # system-prompt 段
  child-bin.ts            # B 运行时入口（boot child cordis.yml）
  child.cordis.yml        # 默认子组合模板
tests/
  tool.test.ts            # 未知 target / 缺目录 / stopReason 映射（provider mock）
  config.test.ts          # 配置校验分支
docs/plan/status.md       # 开发状态跟踪（沿用 enhanced-workspace 惯例）
README.md                 # 安装、配置、Model Experience（harness 包 README 格式）
```

## 6. 分阶段实施与验证

**Phase 0 — 脚手架**：`pnpm init` + 构建链（tsconfig/tsdown/vitest）+ 空插件 `apply` +
`dsh.plugin.json` + `cordis.patch.yml`。
验证：`pnpm typecheck && pnpm build && pnpm pack`；scratch DSH_HOME 下 `dsh plugin add`
能挂载（空 targets 安静退化）。

**Phase 1 — 配置 + 前台工具**：config 校验 + `delegate_workspace` 前台路径，child 先指向
harness 例子 bin（`packages/examples/jsonrpc-demo/lib/bin.js` + 示例 cordis.yml）打通链路。
验证：父会话（headless 跑一个 task）调用工具 → B 在目标目录跑完 → 工具返回 B 的最终输出；
`pnpm test` 覆盖未知 target / 目录缺失 / stopReason 映射（mock provider）。

**Phase 2 — prompt 注入 + 共享 store**：prompt 段、`shareSessionStore` 及 DSH_HOME 显式
传递。
验证：**真实组合测试**（harness 测试策略要求非单元真实组合）：scratch DSH_HOME 起父进程，
配置 target 指向另一目录，跑通全链路并断言：子进程中 B 的 session 出现在父 store、
且 workspace 归属 = 目标目录（检查 session 持久化文件 / 事件日志）；关闭
`shareSessionStore` 时隔离成立。

**Phase 3 — 自研 child bin + 默认 child 组合**：`src/child-bin.ts` + `child.cordis.yml`
模板替换示例 bin，命令可直接用插件内路径。
验证：不用 harness 仓库路径、仅用插件文件跑通 Phase 2 场景。

**Phase 4 — 后台模式 + 收尾**：`ctx.jobs` 后台 Task；README（含 Model Experience：schema
成本、token 影响、KV-cache 影响）；`docs/plan/status.md`；Known Limitations 章节。
验证：后台返回 jobId → `job_output` 拿到结果；并行两路委托同一消息。

## 7. 待验证风险项（实现时逐项实测）

- R1 `scrubbedParentEnv()` 的 DSH_* 剔除面：确认 `DSH_HOME` 只能经 `config.env` 进入子进程，
  且这不影响子进程正常 boot（子进程默认 home 行为）。
- R2 共享 store 时子进程 boot 的 workspace bootstrap 时序：B 的 session 是否正确 attach 到
  目标目录的 workspace（父 UI 可见性依赖它）；若不 attach，`shareSessionStore: true` 的承诺
  降级为"session 同 store 但不出现在列表"（需记录为限制或改方案）。
- R3 可用性：`@deepseek-ai/dsh-subagent` / `dsh-jobs` 等的 npm 发布版本与 `dsh plugin add`
  的解析；不确定则 Phase 1 先复制最小依赖面（只用 `ctx.subagents.start` 的类型）并记录。
- R4 后台模式若 `ctx.jobs` 的 Task 注册契约与预期不符（如需要特定 inject），Phase 4 备选：
  后台先不做，前台同步 + 并行调用覆盖需求（模型可在一条消息里并行发起多个委托）。

## 8. 已知限制（v1 边界）

- 每次委托起一个完整 harness 子进程（全量 boot 插件树），无进程池；连续多委托有启动成本，
  模型应倾向并行发起。
- 子进程仅限本机目录；远程/常驻实例需要新 provider（README 明示 "a remote runtime would
  need its own backend"），留待 v2（可与 dsh-remote 组合）。
- B 的模型/工具/额度由 B 侧 child 组合决定，父无法强制（dsh-sdk provider 无
  outputSchema/depthLimit 能力）。
- 无结构化输出（outputSchema）与 persona/toolFilter 透传（provider 能力限制）。
- 子进程侧若 parent 未配置 `defaultTimeoutMs`，前台调用可能无限等待（模型 turn 由 loop 的
  既有超时/取消机制兜底）。