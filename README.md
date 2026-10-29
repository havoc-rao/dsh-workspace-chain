# dsh-workspace-chain

把当前请求的跨项目后续工作交给**本机另一个目录中的全新 Harness 会话**，收回结果后由当前 agent 整合答复。外部插件，不修改 Harness 本体。

## 已实现的交互

1. 从侧栏把 workspace 或 session 行拖入输入框插入引用（输入区 `@` 菜单、按钮与芯片 hover 预览已移除）；输入框显示工作区引用标签，工作区引用保存 ID 与名称快照；显式 SDK target 仍可使用 `@workspace/project-b` 文本引用。
2. 服务端识别当前 query 中的目标引用、名称和 `aliases`；明确的“继续／刚才那个项目”追问可关联最近六条用户消息。只分析用户消息，不把工具输出当成用户选择。
3. 注入可落日志的 hint，提醒模型结合当前请求、已有对话、目标职责与上游结果作判断。**提及一个项目不等于要求执行**；是否委托仍由 agent 判断。
4. 模型调用 `delegate_workspace`。默认通过宿主 `ctx.sessionController.create({ workspaceId, agentPreset })`（`dsh-api-session-controller` 的 Session Remote，取代已退役的 `apiProxy` 网关）创建真实会话（**会话 ID 在调用时预分配，后台响应与委派记录即时携带**），再由 `sessionController.prompt` 交付自包含任务；传 `session_id` 时改为直接回复上次发布的同一会话。新会话使用宿主默认模型和父会话当前 preset，自动归入目标工作区；只显式配置的 SDK target 使用独立进程。
5. 前台结果直接回给 A；后台返回 job ID，由 `job_output` 收取、`job_kill` 取消。A 核对完成状态、整合结果，再回答原始请求。UI 显示目标、运行／失败／结果已返回状态和可展开的任务、结果。
6. 后台条目使用独立 `workspace-chain` kind（显示为中英本地化“工作区委派 / Workspace delegation”），label 为显式 title 或任务摘要，description 为工作区名称（SDK 为目标名）。本地 `start` 成功取得真实宿主会话后通过 `JobHandle.setSession` 发布，结算后保留。任务卡通过框架注入 hooks 响应 jobs roster 更新；后台仅相信当前父会话 roster 的匹配 jobId，不把响应中的预分配 ID 当作可导航会话。前台成功返回真实 sessionId，已确认本地会话的失败结果附 `sessionConfirmed` presentation meta，均可“打开目标会话”。SDK run id 永不发布会话链接。导航复用 `uiWorkspace.openSession`，与详情、展开、停止分开，点击不发送消息或恢复任务，不拼 URL。

空 targets 也注册后端执行能力。默认 `visibleTools: true` 把 `delegate_workspace` 作为普通工具放进会话顶层 schema 与 `tools:sdk` 段，任何模型都可直接调用；命中 query 时仍注入提示说明用法与并行/超时/回话语义。设 `visibleTools: false` 可退回"仅声明不进 schema"的 deferred 模式（工具注册在后端、用注入的文本声明引导模型发出原生 tool-call，由宿主按名路由——部分模型 loop 不接受 schema 之外的调用，故默认不再使用该模式）。支持原生调用的 native/standard 与 both 模式；宿主强制 code-only 的模式仍由宿主管理，插件不改其执行策略。

## 安装与构建

需要 Node.js 22.16+、pnpm，以及具有 agents/tools/subagents/systemPrompt 服务的 Harness。后台需要 jobs provider 和 job tools；浏览器辅助需要 slots 和 Connection。

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm pack

dsh plugin --profile <你的配置> add file:/absolute/path/dsh-workspace-chain-0.1.1.tgz
```

尚未发布到 npm。默认 bundle patch 的 `targets: {}` 即可使用：宿主提供 `sessionController` 与 `workspaceRegistry` 服务（web profile 的 `session-controller` 行）时，所有已登记的本地工作区都可通过引用委派。无需配置 command、环境变量或子进程模型密钥。

### 版本兼容

已验证的组合：核心运行时 `0.2.1-alpha.1`，`dsh-subagent-dsh-sdk` 与 SDK client 同步 `0.2.1-alpha.1`，Web 类型包 `0.2.1-alpha.1`（宿主 `dsh-host-apiproxy` 已退役，API 边界统一走 profile 的 `sessionController` 服务）。新 provider 已改为 profile/dshBin 接口，不能直接升级替换 command/args。仓库的 `pnpm-workspace.yaml` 固定测试依赖闭包，防止上游 prerelease 范围选到不兼容版本；用于新建测试 profile 时可复用这份约束，已有 profile 应先核对宿主版本。

当前兼容基线已从 `0.1.7-rc.2` 升至 `0.2.1-alpha.1`，旧宿主不再属于本版本支持范围。升级时同步更新 peer、SDK、UI 类型和锁文件，不能只放宽 peer 范围。已通过类型检查、开发构建与 145 项自动化测试；这些检查不代表已重新挂载 profile 或完成真实页面验收。使用本仓库 link 的 profile 可在重启宿主后读取更新；打包安装的 profile 需要重新打包安装。

### 本地 API 与 SDK backend 的加载隔离

本地工作区委派（默认 `targets: {}`）不导入 `dsh-subagent-dsh-sdk`；仅配置显式 SDK targets 时才动态加载该 backend。否则旧 SDK provider 的顶层导入可能与较新宿主的 subagent 导出不兼容（例如缺少 `resolveChildCwd`），在插件注册工具之前就让整个入口导入失败。本地路径不应因未使用的 SDK backend 失效；显式 SDK 路径仍需 provider 与宿主版本匹配，加载失败会如实拒绝，不静默回退成本地执行。

后端入口导入失败可能被 Node 模块缓存保留；重新构建客户端或刷新页面不能清除该缓存。修复后需重新加载后端模块或重启实际宿主，再确认 Loader 激活状态和模型工具列表。

### 本地新增 jobs 契约联调

本次使用宿主新增 `JobView.description/sessionId`、`JobHandle.setSession` 和 `conversation.session.jobs.kind` slot；不支持通过可选方法或强转兼容旧 jobs 版本。jobs/jobs-local 的 overrides 以及客户端 job-controller/ui-workspace dev 依赖指向相邻宿主 checkout；类型解析只将新 jobs 与 ui-jobs slot 映射到宿主已构建的发布声明，并将 Cordis、SessionId 统一解析至现有插件依赖，避免混合类型品牌。宿主需先构建 jobs/jobs-local、api/job-controller、client/ui-workspace、client/ui-jobs 及 slots 声明；正式打包发布时应同步使用包含该契约的版本、移除本地 link/source mappings，而非直接上传带本地依赖的联调配置。

### 宿主侧待核查（2026-09-06 三次 `aborted` 现场遗留的开放项）

- 委派会话是否存在时长/资源限制或被动回收策略，`aborted` / `host-reclaim` 是否对应某条宿主策略；
- 父会话的执行信号在哪些条件下被宿主中止（除用户停止以外的自动路径，如回合切换、运行超时）；
- 宿主 `tool-jobs` 的 `waitTimeoutMs` / `maxWaitTimeoutMs` 实际配置值（决定 `job_output wait` 的上限）。
- 现场三条记录（两个工作区、前/后台混合）均为 `workspace delegation ended: aborted`；若宿主侧确认存在回收策略，应把对应会话恢复指引接回本插件的 `resume.md`。

## 默认本地 API 路径

`@`/拖放引用 → 后续消息披露 `delegate_workspace` → `sessions.create` → `sessions.prompt` → `agent.whenIdle()` → 核验 turn 结果 → 回传当前会话。只接收注册表中的精确工作区路径，不创建任意目录。仅引用不执行。

宿主拥有新会话及其持久化生命周期；任务结束后保留会话，可从工作区列表打开并继续。**会话标题固定**：`sessions.create` 不支持 title 字段，但宿主提供 `sessions.rename`——插件在创建后立即调用它把标题固定为**任务摘要**（任务首行去格式后截断 40 字符，如 `改造 cordis.patch.yml 配置…`），让工作区会话列表直接显示"这个会话在做什么具体任务"；会话已在目标工作区分组下，标题不重复工作区名。想要 `类别/任务` 形式（如 `绘画/画一只猫`）时，在调用中显式传 `title` 即可完全自定义。`pinnedTitles: false` 可关闭（标题回退为宿主自动生成）。rename 事件不开启 turn、不清除 blank 标记；老宿主无 `rename` 或标题被拒时只记录 progress 行，不影响委派。取消/超时调用 `sessions.cancel`，失败和部分输出如实回传。未指定模型时插件不调用 `selectModel`；指定模型时在任务交付前调用它，**该宿主接口同时会保存宿主全局默认模型**。当前会话的有效 preset 从父会话 header 读取。递归委派最多四层。

**会话 ID 创建即得，可随时回到同一会话**：本地委派的会话 ID 由插件在调用入口**预分配**（`session-<uuid>`，宿主 `sessions.create` 契约支持显式 ID 且重试同名同工作区返回同一会话）——后台 job 的初始响应与委派记录在**任务尚未启动**时就携带 `sessionId`，进度行 `session created <id>` 确认会话落地；预分配不代表会话已创建，只有成功取得本地 `start` 返回值后才发布可导航的确认身份（旧宿主不满足当前契约时如实失败，不以预分配 ID 启用导航）。因此上一会话还在运行、刚刚创建、或已经超时/失败，父侧都持有它的 ID 与元数据（`delegationId`、进度/任务书/resume 路径）。要继续它时，把该 ID 作为 **`session_id`** 参数再次调用 `delegate_workspace`：任务直接送进**同一会话**（宿主幂等 adopt/resume，保留原上下文、preset 与标题，不新建会话）；会话仍在运行则消息排队等它空闲。这是重新委派的默认推荐路径——新开会话只会在目标跨会话上下文确实缺失时使用。**续聊必须显式选择**：只有 `session_id` 参数决定回到哪个保留会话。任务文本中的一个或多个 `@[label](dsh-session:…)` 引用仅为历史背景，不自动选择工作区或发送目标；未传 `session_id` 时始终新建会话。本地和 SDK 任务都可携带会话引用作为背景，SDK 仍不支持显式 `session_id`。职责分层为：**引用提供历史信息 → 模型根据用户意图显式选择 target、session_id 与任务 → 执行层仅依据 session_id 判定新建或续聊**。

### 按次指定模型

`delegate_workspace` 新增可选 `model_id`、`provider_id`，旧调用保持不变：

- 用户未指定模型：省略或传空字符串 `model_id`，新会话使用宿主默认，续聊保持目标会话当前模型；SDK 保持 target 配置。
- 用户要求例如 gpt-6.1：先调用 `list_workspace_models({})` 获取模型列表（或用 `provider_id` 限定 provider），从返回的 `models[].id` 选择精确 ID，不把展示名或猜测别名直接传入。
- 再调用 `delegate_workspace({ target, task, model_id: "<返回的模型 ID>", provider_id: "<返回的 provider ID>" })`。模型唯一时可省略 provider；同 ID 跨 provider 时必须指定。provider 不能单独指定。
- 本地新建／续聊均在切换成功后交付任务；运行中的续聊先等待当前工作结束，避免中途换模型。未知模型、歧义、查询或切换失败不会静默退回默认，也不会交付任务。**宿主 `selectModel` 同时保存宿主默认值，这是当前正式接口的副作用。**
- SDK 将精确路由作为本次 `agentOptions` 传给 backend，不修改 target 配置；模型列表来自当前宿主，子 profile 也必须具备该 provider／模型和凭据，否则 SDK 如实失败。
- 显式模型参数写入委派记录和恢复示例，实际解析／选择路由写入进度。

### 引用语义升级说明

旧行为曾把 session 引用所属工作区当作任务目标，并将任务内单个 session 引用自动路由到该会话；本次升级取消这两种隐式推断。只有显式工作区引用能标识定位或任务目标；引用提示统一提供中立元数据与能力状态，不将引用后的 query 转换成待委派任务，不生成默认调用示例，也不默认注入发送指令。只有用户明确要求在目标执行任务时才可委派；session 引用只提供历史背景，其归属名称/路径是元数据，不产生委派示例或工具调用指令。混合引用时，只使用显式工作区作为目标，不能因工作区引用失效而回退到 session 所属工作区。需要续聊的调用方必须迁移为显式传 `session_id`；原先任务含多个引用或 SDK 任务含引用的拒绝逻辑也已移除。引用格式与已有消息不变，升级后旧消息中的 session 引用不会再隐式触发续聊。

## 委派记录与进度协议（checkpoint）

每次 `delegate_workspace` 调用（前台/后台、本地/SDK 路径一致）都会在**目标工作区**写入一份委派记录；`delegationRecords: false` 可整体关闭（关闭后恢复旧行为：任务原文原样交付、无 checkpoint、失败只回传 session id）。

```
<workspace>/.dsh/delegations/<delegationId>/
  task.md      任务书：任务原文 + 目标/工作区/父会话/任务标题/创建时间/超时/会话 ID 元信息
  task.json    同内容的结构化版本（程序化读取用）
  progress.md  进度日志：插件写生命周期行（init/会话创建/任务交付/结算），目标会话按协议追加步骤行
  resume.md    恢复说明 + 可直接使用的续跑任务书样例
```

`delegationId` 形如 `dlg-<YYYYMMDD>-<8hex>`。记录根目录首次生成时，插件会顺带在 `<workspace>/.dsh/` 下写入一个 `.gitignore`（内容为 `*` + `!.gitignore`），委派产物（task/progress/resume 等）不会出现在目标仓库的 `git status` 里，只有这个忽略文件本身入库；若该文件已由用户管理，插件不会覆盖。任务原文交付时附带一个简短信封，向目标会话声明委托 id 与进度文件路径，并要求：**每完成一个可验证步骤向 `progress.md` 追加一行 `- <步骤简述>`，长耗时步骤（构建、测试、等待外部结果等）开始时也追加一行 `- <步骤>…` 并保持周期性追加（活跃心跳，让父侧能确认会话仍在工作），结束时追加 `- [result] <结果摘要>`，不改写已有行**；进度文件不可写时任务照常执行，不因协议失败中断。信封同时告知：父侧超时是活动感知的，只要进度文件或会话日志持续有新内容，等待会自动顺延。

**过程可见性**：后台 job 的 `job_output` 在运行中返回 progress.md 摘要（`delegation dlg-… · N checkpoints` + 尾部若干行），结算后返回最终输出——运行中的委派不再显示 `(no new output)`。前台失败/超时的诊断同样内嵌 checkpoint 路径与尾部摘要。

**恢复路径**：abort/失败后父会话不需要从零重写任务书。`resume.md` 记录目标会话 ID（调用时即预分配落盘）与三种续跑方式：(1) **推荐——回到同一会话**：再次调用 `delegate_workspace` 并传 `session_id: <会话 ID>`，新任务直接送进保留会话，上下文与现场完整（`resume.md` 内已含可直接使用的续跑调用样例）；(2) 宿主界面从目标工作区的会话列表打开保留会话继续；(3) 会话不可用（如被宿主回收）时，在同一工作区新开会话，先读 `task.md` 与 `progress.md`，用 `git status`/diff 与生成产物核对现场，确定未完成步骤后重新委派。

## 失败诊断与等待语义

失败/中止的结算——前台抛出的错误、后台 job 的 `detail`、`DelegationFailure.diagnostic`（程序化消费）——统一包含：

- `Classification:` 一行，取值为 `completed | timeout | cancelled | crash | host-reclaim | refused | max-tokens | failed`。与父侧分析文档的契约 `timeout | cancelled | crash | host-reclaim | unknown` 对齐：`failed` 即 unknown 槽，`refused`/`max-tokens` 为细化分类。
- 目标会话 ID 与 transcript 位置：本地路径为宿主 session store（`<DSH_HOME>/sessions`，宿主可配置根），按会话 ID 找；SDK 路径为 child store（run id ≠ child session id，按 mtime 找）。
- `Checkpoint:` / `Task record:` / `Resume:` 三个文件路径及 progress 尾部摘要。
- `elapsed <ms>` 已等待时长。

分类依据（顺序即优先级）：插件自身活动感知 deadline 触发（目标持续无产出或扩展轮数用尽）→ `timeout`；调用方信号被中止（父会话打断、`job_kill`）→ `cancelled`；child stopReason `error` → `crash`；无我方信号的自发 `aborted` → `host-reclaim`（宿主回收/手动停止/未知宿主侧原因）；`max-tokens`/`refusal` 单独标记；其余 → `failed`。

**区分两个 "aborted"**（现场 `Error: wait aborted` 与任务 `aborted` 不是一回事）：

1. `job_output wait: true` 到达宿主 `tool-jobs` 的等待上限 → **正常返回** `[status: running]` + 上述 progress 摘要（不是报错），可继续非阻塞读取或 `job_list` 查看。
2. `Error: wait aborted` 由宿主 `tool-jobs` 在**调用方本轮执行信号被宿主中止**时抛出（父会话被打断/取消/回收）——任务仍在运行，重新 `job_output`（不带 wait）或 `job_list` 即可。`waitTimeoutMs`/`maxWaitTimeoutMs` 属宿主配置。

**护栏（活动感知超时）**：前台/后台统一受 `timeout_ms`（默认 `defaultTimeoutMs` 300000ms，本地/SDK 路径一致生效）约束，但这不是硬上限——到点先探测目标会话是否仍在工作：本地 agent `status === 'running'`、`<DSH_HOME>/sessions` 目录近期有写入、或 `progress.md` 出现目标侧新增的 checkpoint 行（插件自身 `[init]`/`[start]`/`[extend]` 生命周期行不算），任一命中即自动顺延一个 `timeoutExtensionMs`（默认 120000ms）窗口，累计最多 `maxTimeoutExtensions`（默认 10）轮；只有目标**长时间无任何产出**或扩展轮数用尽，才 `sessions.cancel` 子会话并按 `timeout` 分类返回，诊断 detail 会写明停等时长与最后观测到的活动（`[extend]` checkpoint 行也进入 progress，`job_output` 可实时看到顺延过程）。执行中被父侧信号中止则按 `cancelled` 分类返回。两种情况下宿主都保留子会话、`resume.md` 给出续跑指引。长任务建议 `run_in_background: true`；可并行的子任务应先挂后台再继续其他工作。参数新增可选 `timeout_ms`（正整数毫秒），仅扩展、不破坏旧调用。

## 可选 SDK 配置

显式配置的 SDK target 优先于同目录的默认本地路径。以下参数和 Store 策略仅适用于 SDK 路径。

```yaml
- id: workspace-chain
  config:
    toolName: delegate_workspace
    promptEnabled: true
    defaultTimeoutMs: 300000
    timeoutExtensionMs: 120000
    maxTimeoutExtensions: 10
    shareSessionStore: true
    targets:
      project-b:
        purpose: 'Backend service: API and database work'
        aliases: [后端项目, backend]
        cwd: /absolute/path/to/project-b
        # 缺省 profile 为 sdk；缺省 patches 为包内 src/child.patch.yml。
        # 显式 dshBin 仅在需要自定义 dsh CLI 可执行文件时提供。
        patches: [/absolute/path/to/your-child.patch.yml]
        env:
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
        provider: deepseek-official
        model: deepseek-v4-flash
        maxTokens: 8192
```

SDK target 的 child 由 dsh CLI 以 `sdk` headless profile（`dsh-base` + `dsh-sdk-app` 组合）启动，再叠加有序 profile patch：包内 `src/child.patch.yml` 恢复插件历史 child 调优（`maxTokensAsSuccess: false`、指令上限 32KB），不加载 Web UI，stdout 留给 JSON-RPC。`patches` 缺省使用该打包 patch；提供列表则整体替换，patch 内的 `- id: <x> disabled: true` 与 `- insert:` 块可覆盖/扩展 base 组合。

可配置项：`dshBin`（显式 dsh CLI 模块，缺省用 SDK 依赖的同版本 dsh）、`profile`（缺省 `sdk`）、`patches`（相对父进程 cwd 解析，加载时校验存在）、`dshHome`（child 专用 Harness home，缺省随 `shareSessionStore` 推导，见下）、`env`、`provider`/`model`/`maxTokens`。B 的模型、工具及执行权限由 profile+patch 组合决定；内置 shell/fs 是 base 的本地执行器，若需要沙箱或审批，请在 patch 中提供相应组合。

目标 cwd 在加载时 realpath 校验，调用时复查。缺失 cwd、patch 文件不存在、文件路径冒充目录、无效 timeout/env/dshHome 均报配置错误。SDK 路径只接受目标名字和 task，不能指定任意目录、命令或环境变量。相对 cwd 在父进程加载时解析；patch 路径按父进程 cwd 解析。

## SDK Store 策略

- `shareSessionStore: true`：child `dshHome` 固定为父侧解析后的 DSH_HOME，B 写入同一个 sessions 根目录；显式配置的 `dshHome`/`env.DSH_HOME` 与共享语义冲突会被拒绝。
- `false`：child `dshHome` 默认使用 `<目标 cwd>/.dsh-workspace-chain`，也可显式配置不同于父 home 的 `dshHome` 或 `env.DSH_HOME`。**仅省略 dshHome 无法隔离**，因为会回落到 `~/.dsh`。
- 内置持久化默认 zstd，与 Harness base 对齐。若父组合使用 `compression: none` 或自定义 sessions 根目录，child patch 必须显式对齐；共享 dshHome 不会自动复制父组合。
- 环境继承由 SDK provider 的 `scrubbedParentEnv()` 完成。凭据和 `DSH_*` 默认清除；需要的值通过 target.env 显式传入。UI catalog 不包含 cwd、dshHome、patches 或 env。

**仅 SDK 路径的限制：同 store + 正确 cwd 已实测，但不会自动挂接父 UI 的工作区会话列表。默认本地 API 路径会自动归属工作区。** 当前 provider 的 `run.id` 是父侧运行 ID，和 B 的持久化 session ID 不同，且没有暴露二者映射。因此结果卡只展示结果和后台 job ID，不提供会跳错的子会话链接，也不伪造 workspace membership。修复需要 provider 暴露真实 child session identity；本插件没有新增旁路传输。

## 工具与后处理

参数：`target: string`、`task: string`、`run_in_background?: boolean`、`timeout_ms?: number`（覆盖默认超时，默认 `defaultTimeoutMs`，本地/SDK 路径均生效）、`title?: string`（可选，自定义固定会话标题，如 `绘画/画一只猫`；缺省为任务摘要，仅本地路径有 rename 效果，SDK 路径只写入任务书）、`session_id?: string`（**仅本地路径**：回到已发布的同一会话继续——把上次委派返回/记录的会话 ID 传入，任务直接送进该保留会话，不新建；未传时始终新建会话；任务文本中的 `dsh-session` 引用仅为历史背景，不影响路由。详见「默认本地 API 路径」）。SDK target 传 `session_id` 会明确报错，但任务文本允许携带一个或多个会话引用作为背景。task 应含相关上游结果、目标文件、预期行为和验收标准；不复制 A 的全部历史。

**并行建议**：同一请求可拆成多个互不依赖的子任务时（例如只等对方返回某个 key / 契约名，或改动互不干扰的多个工作区），对可并行的部分用 `run_in_background: true` 挂后台、继续处理其他事情，最后统一用 `job_output` 收取结果并整合；只有下一步必须依赖其结果时才前台等待。工具描述与 invocation hint 已内置这一决策规则，超时活动感知语义见上文「失败诊断与等待语义」。

前台成功的规范值包含 `{ kind: 'foreground', runId, output, sessionId?, delegationId?, checkpointPath? }`（本地路径包含真实 sessionId，用于 UI 元信息，不混入模型的结果文本；`delegationId`/`checkpointPath` 指向该次委派记录），模型读到 B 的最终文本；非 completed 的 stop reason 返回工具错误，错误携带分类诊断与记录路径。完成与失败均等待运行收尾；本地路径保留宿主会话，SDK 路径释放子进程。后台使用 parent-owned jobs，成功输出经 `job_output` 返回，运行中可经 `job_output` 读 checkpoint 摘要；**本地路径的后台响应同样携带 `sessionId`（预分配，job 启动前即已知，进度行 `session created <id>` 确认落地）**，取消和超时传递到 provider，结算 detail 含分类诊断（`timeout`/`cancelled`/`crash`/`host-reclaim` 等），清理失败不会被当成成功。失败/超时诊断中的 `Target session:` 与 `resume.md` 给出同一会话 ID——配合 `session_id` 参数即可直接回复该会话。

后处理是现有 agent loop 的工具结果回流，加上 prompt/hint 中的核对、整合要求；没有另起一个模型改写器，也没有 turn 结束后自动触发下一次委托。这样返回结果不会自行形成无限工作区链。

## Model Experience

- 空 targets 也注册三参数后端能力。已登记工作区默认使用本地 API；接口不可用时明确报告，不猜测启动命令。
- `system-prompt/assemble` 过滤本工具的顶层 schema，并用宿主公开 SDK renderer 重建不含本工具的 `tools:sdk` section，保留宿主原有 system/tools 前缀。遇到其他插件自定义 SDK 文本会明确报错，不盲目覆盖。
- 命中 query 时追加短 hint，并通过现有 `agent/pre-step` → `user/message` 路径持久化；它只影响当前新增上下文，不重写历史。
- UI 不注入隐藏命令，引用的剪贴板文本与发送文本一致。
- 默认本地路径复用宿主，创建新会话；SDK 子任务每次完整启动独立 runtime，有启动成本。独立任务可以并行。没有进程池、常驻实例、远程传输、结构化输出或跨进程 persona/toolFilter 强制策略。

## 验证

`pnpm test` 包含配置／工具／query／UI DOM 测试，以及真实 Cordis + SDK 子进程组合测试（模型和 code runtime 使用确定性 fixture，无需 API key）：多个目标并行、前后台结果、A 的实际模型请求中的 hint/tool、A 整合结果、凭据清洗、共享／隔离会话落盘、父持久化服务重新发现 child headers、run ID 与 child ID 不同的回归断言。委派记录专项覆盖：task.md/task.json/progress.md/resume.md 落盘与内容、checkpoint 追加/摘要截断/结算行、任务书信封（含禁用开关与不可写降级）、失败分类（crash/timeout/cancelled/host-reclaim/max-tokens/refused/failed 优先级）、前台错误消息与后台 job detail 中的分类/transcript/checkpoint/resume 路径、后台 `readOutput` 运行中返回 progress 摘要且结算后返回最终输出、`timeout_ms` 覆盖与落盘、本地路径端到端的记录与真实会话 ID 关联。

`node scripts/smoke-install.mjs <tgz>` 在临时 DSH_HOME 中通过实际 `dsh plugin add` 安装包、验证 bundle 挂载，并 boot 空 targets。仅使用缓存时会带 `--offline`，不修改个人 profile。

浏览器辅助通过 DOM 渲染和点击行为测试；当前执行环境未连接浏览器，尚未完成真实 DSH Web 页面视觉验收。真实商业模型调用未执行。

### 委派体验手工验收步骤（对应父侧分析文档用例 A–D）

- 用例 A（结构化失败）：对任意本地工作区委派一个长任务（跨仓库改动+构建+测试），前台与后台各一次，观察超时后返回 `Classification: timeout` + elapsed + checkpoint/resume 路径，而非裸 `aborted`。
- 用例 B（过程可见）：任务进行中调 `job_output`，应读到 `delegation dlg-… · N checkpoints` 摘要（含目标会话的步骤行；无输出行则说明协议未生效）。
- 用例 C（等待语义）：`job_output wait: true` 超过宿主 wait 上限 → `[status: running]` + 摘要；若出现 `Error: wait aborted`，说明父侧信号被宿主中止，任务仍在跑，重新 `job_output`/`job_list` 验证。
- 用例 D（恢复）：abort 后阅读 `<workspace>/.dsh/delegations/<id>/resume.md`，用其中样例（含 `session_id`）再次调用 `delegate_workspace`，确认任务被同一会话接收续跑（会话列表不新增条目）；会话不可用时再按样例 3 的方式新开会话续跑。
- 宿主侧（P6）：核对会话回收策略与 `tool-jobs` wait 配置（见"宿主侧待核查"）。

## 引用拖放

输入区引用入口为纯拖放：配套 `dsh-enhanced-workspace` 的 workspace 行支持排序与引用拖动，非空 session 行支持引用拖动；侧栏区域保留排序操作。拖放协议为 `application/x-dsh-reference+json`，载荷 `{version:1,kind:"workspace"|"session",id}`；接收方以实时列表校验 ID，再通过输入框的 revision 校验接口插入，不自动发送。原先的 `@` 候选菜单（`conversation.input.overlay`）、输入栏 `@` 按钮与输入框 chip hover 预览已移除，宿主原生 `@` 菜单恢复。

### 输入框插入 API 升级要求

本地联调的 `tsconfig.json` 将 conversation/client 与 ui-slots 的类型入口映射到相邻 Harness checkout 已构建的 `lib/types`，确保使用实际公开 InputActions 及一致的 SlotMap 类型身份；package.json 与 pnpm-lock 的发布依赖不变。这只是开发类型映射，不替换客户端 runtime。发布／非相邻 checkout 构建时必须同步包含 `insertReference`／`focus` 的新版 core 类型包与宿主，再移除或调整此开发映射；仅安装旧 `0.2.1-alpha.1` 不能证明新 API 可用。

宿主必须公开 `InputActions.insertReference(reference, span)` 和 `InputActions.focus()`；插件将结构化插入与 `captureInsertion()` 配对，检测捕获的插入坐标与 revision guard，避免草稿已变化后按过期位置插入。只有插入返回 true 后才同步调用公开 `focus()`，恢复 InputBar 实际 contenteditable 的焦点并由宿主保留 Lexical 选区、preventScroll；失败／锁定／未知引用／tree／Files 不 focus，不延迟、不查询 DOM 绕过 API。插件 action 类型直接派生自公开 `InputActions`。旧 core 缺少插入或 focus 方法时明确拒绝并显示本地化提示，不再通过 `scope.bail`、`execCommand` 或原文文本 fallback 伪装成功插入。

引用拖放由唯一 window capture owner 处理；拖入主应用非侧栏区域时恢复与图片拖入类似的全屏 tips，可在 conversation 外区域释放，加入当前可见 composer。遮罩通过 body portal 跳出 overflow，使用 mask-drop／blur／语义色 token，pointer-events: none 保持底层真实 target；标题、说明及 blocked 状态统一走 locale，失败仍有局部反馈。侧栏树重排不被抢占，Files 完全交由图片 owner。多个 mounted dock 按宿主真实 data-conversation-session occurrence 和 DOM 可见状态选择；非 occurrence 区域只在唯一可见 dock 时接收，不猜测 split view。配套 enhanced-workspace 的旧引用 drop router 必须移除，避免重复接收/插入。升级时需同步宿主输入框 API、当前插件及配套 enhanced-workspace，不能仅替换本插件 bundle。

引用层不替换附件 slot。含 `Files` 的拖动完全交由原生图片流程；全局引用层不接收普通文本或旧版仅含 workspace ID 的拖动，避免拦截文本拖放。

消息气泡中的 workspace 标签本体（图标＋名称）采用与输入框 chip 相同的圆角及 hover 蓝色背景 token；仅 CSS `:hover` 改背景，不改变 hover 前后尺寸，保留自然换行和既有 Tooltip 行为。

Session 使用原生 `@[label](dsh-session:...)` 格式，历史解析依赖宿主的 session-reference 能力。Workspace 使用 `@workspace-id/<encoded-id>`，由宿主 registry 解析标题与路径，并关联同 cwd 的已配置委托目标；引用整个项目不自动加载其全部会话，也不自动添加执行权限。已有 `@workspace/<target>` 委托目标引用保持兼容。

LLM hint 通过字段白名单只投影类型、名称和项目路径；只有显式工作区引用有可用委托目标且宿主允许原生分派时才附加目标能力元数据。任何工作区引用只输出中立能力状态（包含未解析／API 不可用／调用模式限制），不自动提取 query 作为任务、不生成默认调用示例、不追加 invocation 指令。session 引用的工作区归属仅为历史元数据，不推断任务目标、不附加委派示例/工具调用指令。禁止序列化 registry 实体、record、host、session 列表或 logo，不在新增 hint 中披露内部 ID。工具说明仅经 `agent/pre-step` 追加到后续消息，不注册 system section。引用协议仍在内部保留稳定 ID；原生 session resolver 的历史注入不由此规则改写。

引用能力提示区分目标未配置、引用无法解析、工具不可调用等状态，但不把引用后的文字作为待执行任务，也不产生具体调用示例。是否委派必须由用户的明确执行请求决定；全屏拖放只插入引用，不发送消息或执行任务。此提示不会自动填充 profile 的 targets，也不会绕过目标运行配置。

本地路径新增 API 契约 + 真实 agent loop 测试（模型 fixture），覆盖空 targets 的 query→调用→结果回流、工作区归属、会话继续及取消竞态。当前缓存的 apiproxy 实现与其 api-remotes 依赖不兼容，故测试替换宿主 API 边界，未声称完成真实宿主 API 或供应商验收。插件运行时只使用宿主提供的 API，新增依赖仅用于类型检查，不加载另一份 API 实现。

## 已发送消息的工作区引用

新引用使用 `@workspace-ref/<base64url JSON>`，JSON 仅含 `{id,label}`；名称是显示快照，委派始终按 ID 查注册表。拖放、复制与发送保留同一身份。旧 `@workspace-id/<id>` 继续可用；identity codec 不会自动为旧草稿补齐名称。

DSH ui-conversation 的可复用 factory `conversation.user-text` 唯一声明通用 chain slot `conversation.message.reference`（`kind: 'chain'`、`scope: 'session'`、`owner: { token: string }`）。chat 与 queue 通过 factory 投影；普通 `@` token 在文件 fallback 前交给 chain select。本插件以 priority -10 注册 `selectWorkspaceReference`，只接管完整、有效的 workspace token；文件、session wire、skill 与无效协议保持宿主处理，不增加 InputTriggerSource hook。

组件从 `useWorkspaces` 读取当前名称，移除后的新引用使用名称快照；没有快照的旧引用显示本地化的“工作区不可用”。常态只展示工作区名称；使用官方 Tooltip，悬停 500ms 或键盘聚焦后仅原样展示该引用发送给 LLM 的文本（`@workspace-ref/…` 或旧版 `@workspace-id/…`），不附加路径、解码字段或解释文案。详情仅在 tooltip 打开时挂载，portal 避免消息/队列容器裁剪。组件使用官方 `ReferenceIconRegular` folder 图标与共享主题 token，保持消息/队列的行内基线和换行策略；文案归属 `workspace-chain.reference` locale namespace（中文/英文）。工作区 chip 仅作展示，没有点击导航，不应被误送到文件预览。复制消息保留原始引用，渲染不修改历史或委派参数。

需要同时加载带上述 factory/slot 的 DSH conversation、chat/queue bundles 与本插件 bundle；仅更新插件无法为旧宿主补出入口。本地使用已发布 `0.2.1-alpha.1` UI 类型；该发布包尚未声明 `conversation.message.reference`，因此该 slot 仍保留与本地宿主一致的编译期 shim。审批详情与 `useChat` 已直接使用宿主类型，工具卡片的准备阶段通过 `block.args` 读取流式参数。图标来自共享平台模块，locale 仅使用 Cordis 服务，不捆绑另一份宿主实现。

开发联调执行 `NODE_ENV=development pnpm build`。官方 profile 通道加载 `lib/client.js`（模块 ID `dsh-workspace-chain`），plugin-registry 通道加载 `lib/client-registry.js`（模块 ID `dsh-external/dsh-workspace-chain`）。已链接本工作区的宿主可在重新加载插件/刷新页面后读取新 bundle；若安装的是打包副本，需要重新打包并更新安装。客户端 HMR 只有在同一 Harness checkout 的 `pnpm run dev:web` watcher 已运行并确认资源来源时才可依赖。构建、profile 挂载和真实页面验收是不同状态。

## 跨工作区编辑拦截的委派助手（提权审批注入）

编辑其他路径下文件被文件沙箱 hook 拦截（`[sandbox: file access denied …]`）需要提权时，本插件提供两层联动：

1. **服务端自动上行 tip**：`tools/post-execute` 监听 `edit`/`write` 的结果，命中沙箱拒绝且目标路径属于另一个已登记工作区（registry workspace 或显式 SDK target，规范路径包含匹配，未创建文件按最深已存在祖先解析）时，按与 workspace hints 相同的注入方式（plugin instruction，`form: instructions`）把“该路径属于工作区 B，可将此编辑任务委派给该工作区，或继续提权等用户审批”附加到工具结果的 `additionalContexts`，随下一次模型请求进入上下文。委派工具对该 agent 不可见或目标不可委派时只说明归属，不给出工具调用指引；同一条结果已有本插件提示时不重复注入。当前会话自身工作区内的路径（普通拒绝）不产生提示。

2. **审批面板查询按钮**：接管 `conversation.approval.detail` 单元（priority -10 压过官方命令行，保留 shell 命令展示）。`edit`/`write` 的提权审批挂起时显示目标路径与归属查询：进入即自动查询（可重新查询），RPC 端点 `ownerOf`（`/workspace-chain` channel，`authority: loopback`）返回可信归属列表与当前会话所属工作区。置于另一个工作区 → 展示委派建议与“复制委派指令”；属于当前工作区 → 提示正常审批提权即可；未匹配 → 提示继续提权或取消。

客户端 bundle 对 `conversation.approval.detail` 与 `useChat` 的声明为结构性 shim（编译期先于宿主 ui-approval/ui-chat 类型面），运行时契约由宿主 profile 提供；宿主未组合审批 UI 时该单元不渲染，行为不变。归属查询只读（realpath + 前缀判断），不读写任何工作区内容，不自动委派。
