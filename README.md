# dsh-workspace-chain

把当前请求的跨项目后续工作交给**本机另一个目录中的全新 Harness 会话**，收回结果后由当前 agent 整合答复。外部插件，不修改 Harness 本体。

## 已实现的交互

1. 输入 `@`，从 workspace-chain 候选中选择目标；输入框显示工作区引用标签，工作区引用保存 ID 与名称快照；显式 SDK target 仍使用 `@workspace/project-b`。
2. 服务端识别当前 query 中的目标引用、名称和 `aliases`；明确的“继续／刚才那个项目”追问可关联最近六条用户消息。只分析用户消息，不把工具输出当成用户选择。
3. 注入可落日志的 hint，提醒模型结合当前请求、已有对话、目标职责与上游结果作判断。**提及一个项目不等于要求执行**；是否委托仍由 agent 判断。
4. 模型调用 `delegate_workspace`。默认通过宿主 `ctx.apiProxy.sessions.create({ workspaceId, agentPreset })` 创建真实会话，再由 `sessions.prompt` 交付自包含任务。新会话使用宿主默认模型和父会话当前 preset，自动归入目标工作区；只显式配置的 SDK target 使用独立进程。
5. 前台结果直接回给 A；后台返回 job ID，由 `job_output` 收取、`job_kill` 取消。A 核对完成状态、整合结果，再回答原始请求。UI 显示目标、运行／失败／结果已返回状态和可展开的任务、结果。

空 targets 也注册后端执行能力，但不加入顶层 tools 或 system prompt。命中 query 时，在后续消息中提供 `delegate_workspace` 的工具名、参数和原生 tool-call 调用说明，不依赖 run_code。支持原生调用的 native/standard 与 both 模式；宿主强制 code-only 的模式仍由宿主管理，插件不改其执行策略。后续上下文中的声明不等于所有模型供应商都支持未列入顶层 tools 的调用，需以实际模型验收为准。

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

尚未发布到 npm。默认 bundle patch 的 `targets: {}` 即可使用：宿主提供 `apiProxy` 与 `workspaceRegistry` 时，所有已登记的本地工作区都可通过引用委派。无需配置 command、环境变量或子进程模型密钥。

### 版本兼容

已验证的组合：核心运行时 `0.1.2-rc.1`，`dsh-subagent-dsh-sdk` 与 SDK client **固定 `0.1.1-rc.2`**，Web 类型包 `0.1.1-rc.2`。新 provider 已改为 profile/dshBin 接口，不能直接升级替换 command/args。仓库的 `pnpm-workspace.yaml` 固定测试依赖闭包，防止上游 prerelease 范围选到不兼容版本；用于新建测试 profile 时可复用这份约束，已有 profile 应先核对宿主版本。

### 宿主侧待核查（2026-09-06 三次 `aborted` 现场遗留的开放项）

- 委派会话是否存在时长/资源限制或被动回收策略，`aborted` / `host-reclaim` 是否对应某条宿主策略；
- 父会话的执行信号在哪些条件下被宿主中止（除用户停止以外的自动路径，如回合切换、运行超时）；
- 宿主 `tool-jobs` 的 `waitTimeoutMs` / `maxWaitTimeoutMs` 实际配置值（决定 `job_output wait` 的上限）。
- 现场三条记录（两个工作区、前/后台混合）均为 `workspace delegation ended: aborted`；若宿主侧确认存在回收策略，应把对应会话恢复指引接回本插件的 `resume.md`。

## 默认本地 API 路径

`@`/拖放引用 → 后续消息披露 `delegate_workspace` → `sessions.create` → `sessions.prompt` → `agent.whenIdle()` → 核验 turn 结果 → 回传当前会话。只接收注册表中的精确工作区路径，不创建任意目录。仅引用不执行。

宿主拥有新会话及其持久化生命周期；任务结束后保留会话，可从工作区列表打开并继续。**会话标题固定**：`sessions.create` 不支持 title 字段，但宿主提供 `sessions.rename`——插件在创建后立即调用它把标题固定为**任务摘要**（任务首行去格式后截断 40 字符，如 `改造 cordis.patch.yml 配置…`），让工作区会话列表直接显示"这个会话在做什么具体任务"；会话已在目标工作区分组下，标题不重复工作区名。想要 `类别/任务` 形式（如 `绘画/画一只猫`）时，在调用中显式传 `title` 即可完全自定义。`pinnedTitles: false` 可关闭（标题回退为宿主自动生成）。rename 事件不开启 turn、不清除 blank 标记；老宿主无 `rename` 或标题被拒时只记录 progress 行，不影响委派。取消/超时调用 `sessions.cancel`，失败和部分输出如实回传。插件不调用 `selectModel`，避免该接口连带修改宿主全局默认模型。当前会话的有效 preset 通过 `sessions.list` 读取。递归委派最多四层。

## 委派记录与进度协议（checkpoint）

每次 `delegate_workspace` 调用（前台/后台、本地/SDK 路径一致）都会在**目标工作区**写入一份委派记录；`delegationRecords: false` 可整体关闭（关闭后恢复旧行为：任务原文原样交付、无 checkpoint、失败只回传 session id）。

```
<workspace>/.dsh/delegations/<delegationId>/
  task.md      任务书：任务原文 + 目标/工作区/父会话/任务标题/创建时间/超时/会话 ID 元信息
  task.json    同内容的结构化版本（程序化读取用）
  progress.md  进度日志：插件写生命周期行（init/会话创建/任务交付/结算），目标会话按协议追加步骤行
  resume.md    恢复说明 + 可直接使用的续跑任务书样例
```

`delegationId` 形如 `dlg-<YYYYMMDD>-<8hex>`。任务原文交付时附带一个简短信封，向目标会话声明委托 id 与进度文件路径，并要求：**每完成一个可验证步骤向 `progress.md` 追加一行 `- <步骤简述>`，结束时追加 `- [result] <结果摘要>`，不改写已有行**；进度文件不可写时任务照常执行，不因协议失败中断。

**过程可见性**：后台 job 的 `job_output` 在运行中返回 progress.md 摘要（`delegation dlg-… · N checkpoints` + 尾部若干行），结算后返回最终输出——运行中的委派不再显示 `(no new output)`。前台失败/超时的诊断同样内嵌 checkpoint 路径与尾部摘要。

**恢复路径**：abort/失败后父会话不需要从零重写任务书。`resume.md` 给出两种续跑方式：(1) 宿主界面从目标工作区的会话列表打开保留会话直接继续（原上下文完整）；(2) 在同一工作区新开会话，先读 `task.md` 与 `progress.md`，用 `git status`/diff 与生成产物核对现场，确定未完成步骤后重新委派——`resume.md` 内已含可直接使用的续跑任务书样例（新会话读任务文件 + 现场后继续，验收完成后报告）。

## 失败诊断与等待语义

失败/中止的结算——前台抛出的错误、后台 job 的 `detail`、`DelegationFailure.diagnostic`（程序化消费）——统一包含：

- `Classification:` 一行，取值为 `completed | timeout | cancelled | crash | host-reclaim | refused | max-tokens | failed`。与父侧分析文档的契约 `timeout | cancelled | crash | host-reclaim | unknown` 对齐：`failed` 即 unknown 槽，`refused`/`max-tokens` 为细化分类。
- 目标会话 ID 与 transcript 位置：本地路径为宿主 session store（`<DSH_HOME>/sessions`，宿主可配置根），按会话 ID 找；SDK 路径为 child store（run id ≠ child session id，按 mtime 找）。
- `Checkpoint:` / `Task record:` / `Resume:` 三个文件路径及 progress 尾部摘要。
- `elapsed <ms>` 已等待时长。

分类依据（顺序即优先级）：插件自身 deadline 触发 → `timeout`；调用方信号被中止（父会话打断、`job_kill`）→ `cancelled`；child stopReason `error` → `crash`；无我方信号的自发 `aborted` → `host-reclaim`（宿主回收/手动停止/未知宿主侧原因）；`max-tokens`/`refusal` 单独标记；其余 → `failed`。

**区分两个 "aborted"**（现场 `Error: wait aborted` 与任务 `aborted` 不是一回事）：

1. `job_output wait: true` 到达宿主 `tool-jobs` 的等待上限 → **正常返回** `[status: running]` + 上述 progress 摘要（不是报错），可继续非阻塞读取或 `job_list` 查看。
2. `Error: wait aborted` 由宿主 `tool-jobs` 在**调用方本轮执行信号被宿主中止**时抛出（父会话被打断/取消/回收）——任务仍在运行，重新 `job_output`（不带 wait）或 `job_list` 即可。`waitTimeoutMs`/`maxWaitTimeoutMs` 属宿主配置。

**护栏**：前台调用同样受 `timeout_ms`（默认 `defaultTimeoutMs` 300000ms，本地路径与 SDK 路径一致生效）约束，超时自动 `sessions.cancel` 子会话并按 `timeout` 分类返回；执行中被父侧信号中止则按 `cancelled` 分类返回，两种情况下宿主都保留子会话、`resume.md` 给出续跑指引。长任务建议 `run_in_background: true`。参数新增可选 `timeout_ms`（正整数毫秒），仅扩展、不破坏旧调用。

## 可选 SDK 配置

显式配置的 SDK target 优先于同目录的默认本地路径。以下参数和 Store 策略仅适用于 SDK 路径。

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

目标 cwd 在加载时 realpath 校验，调用时复查。缺失 cwd/command、文件路径冒充目录、无效 timeout/env 均报配置错误。SDK 路径只接受目标名字和 task，不能指定任意目录、命令或环境变量。相对 cwd 在父进程加载时解析；command/args 按子进程执行语义解析。

## SDK Store 策略

- `shareSessionStore: true`：显式传父侧解析后的 `DSH_HOME`，B 写入同一个 sessions 根目录；冲突的目标 `DSH_HOME` 会被拒绝。
- `false`：默认使用 `<目标 cwd>/.dsh-workspace-chain`，也可显式配置不同于父 home 的 `env.DSH_HOME`。**仅省略 DSH_HOME 无法隔离**，因为会回落到 `~/.dsh`。
- 内置持久化默认 zstd，与 Harness base 对齐。若父组合使用 `compression: none` 或自定义 sessions 根目录，child 配置必须显式对齐；共享 DSH_HOME 不会自动复制父组合。
- 环境继承由 SDK provider 的 `scrubbedParentEnv()` 完成。凭据和 `DSH_*` 默认清除；需要的值通过 target.env 显式传入。UI catalog 不包含 cwd、command、args 或 env。

**仅 SDK 路径的限制：同 store + 正确 cwd 已实测，但不会自动挂接父 UI 的工作区会话列表。默认本地 API 路径会自动归属工作区。** 当前 provider 的 `run.id` 是父侧运行 ID，和 B 的持久化 session ID 不同，且没有暴露二者映射。因此结果卡只展示结果和后台 job ID，不提供会跳错的子会话链接，也不伪造 workspace membership。修复需要 provider 暴露真实 child session identity；本插件没有新增旁路传输。

## 工具与后处理

参数：`target: string`、`task: string`、`run_in_background?: boolean`、`timeout_ms?: number`（覆盖默认超时，默认 `defaultTimeoutMs`，本地/SDK 路径均生效）、`title?: string`（可选，自定义固定会话标题，如 `绘画/画一只猫`；缺省为任务摘要，仅本地路径有 rename 效果，SDK 路径只写入任务书）。task 应含相关上游结果、目标文件、预期行为和验收标准；不复制 A 的全部历史。

前台成功的规范值包含 `{ kind: 'foreground', runId, output, sessionId?, delegationId?, checkpointPath? }`（本地路径包含真实 sessionId，用于 UI 元信息，不混入模型的结果文本；`delegationId`/`checkpointPath` 指向该次委派记录），模型读到 B 的最终文本；非 completed 的 stop reason 返回工具错误，错误携带分类诊断与记录路径。完成与失败均等待运行收尾；本地路径保留宿主会话，SDK 路径释放子进程。后台使用 parent-owned jobs，成功输出经 `job_output` 返回，运行中可经 `job_output` 读 checkpoint 摘要；取消和超时传递到 provider，结算 detail 含分类诊断（`timeout`/`cancelled`/`crash`/`host-reclaim` 等），清理失败不会被当成成功。

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
- 用例 D（恢复）：abort 后阅读 `<workspace>/.dsh/delegations/<id>/resume.md`，按样例在新会话续跑（读 task.md + progress.md，检查 git status/diff 与产物后继续）。
- 宿主侧（P6）：核对会话回收策略与 `tool-jobs` wait 配置（见"宿主侧待核查"）。

## 分层引用与拖放

`@` 菜单由 `ReferenceMenu` 组件占用 `conversation.input.overlay` 的 `slash-menu` 单元（priority -10），卸载后恢复原菜单。入口按本项目、其他 workspace、未归属项目的 session、委托目标及其他已注册来源分类；进入项目后选择 workspace 本身或 session，进入 session 后可选择它及 fork。子代理按 origin 单独标识。分类列表和搜索结果带层级标题，避免同名项目或会话混淆。

继续在输入框输入可搜索；进入某一层后，结果限制在该层。其他来源继续使用原有候选查询及 pick 接口。上下键、Enter、Esc 操作当前可见层级；点击候选保留输入框焦点。

输入栏通过 `conversation.input.left` slot 添加小型 `@` 按钮，不再占用上方独立横条。配套 `dsh-enhanced-workspace` 的 workspace 行支持排序与引用拖动，非空 session 行支持引用拖动。拖入页面时显示 portal 全屏引用遮罩，使用与原生图片遮罩相同的主题变量；侧栏区域保留排序操作。拖放协议为 `application/x-dsh-reference+json`，载荷 `{version:1,kind:"workspace"|"session",id}`；接收方以实时列表校验 ID，再通过输入框的 revision 校验接口插入，不自动发送。

原生图片 `DropOverlay` 没有公开扩展接口，因此引用层由插件独立实现，不替换附件 slot。含 `Files` 的拖动完全交由原生图片流程；全局引用层不接收普通文本或旧版仅含 workspace ID 的拖动，避免拦截文本拖放。

Session 使用原生 `@[label](dsh-session:...)` 格式，历史解析依赖宿主的 session-reference 能力。Workspace 使用 `@workspace-id/<encoded-id>`，由宿主 registry 解析标题与路径，并关联同 cwd 的已配置委托目标；引用整个项目不自动加载其全部会话，也不自动添加执行权限。已有 `@workspace/<target>` 委托目标引用保持兼容。

当前层级基于客户端已加载的 session/workspace 列表；不推测未提供的 fork 关系。其他来源的查询范围与召回能力由各自插件决定。

输入框中的结构化 workspace/session 蓝链支持延迟 hover 预览：内部按 occurrence ID 与引用 ID 对齐，展示标题、路径、所属项目、更新时间、父会话名称和委托配置，不展示内部 ID。预览不读取整段历史；宿主未提供的分叉位置不展示。输入框目前没有 chip hover slot，插件在自身 input.left 挂载点监听当前输入卡片，按原生 chip 的矩形和 `data-occurrence` 命中；不修改 Harness 或输入框的指针行为。此预览目前作用于发送前的输入框引用，不接管历史消息里的链接。

LLM hint 通过字段白名单只投影类型、名称和项目路径；有可用委托目标且宿主允许原生分派时才附加目标与调用说明。禁止序列化 registry 实体、record、host、session 列表或 logo，不在新增 hint 中披露内部 ID。工具说明仅经 `agent/pre-step` 追加到后续消息，不注册 system section。引用协议仍在内部保留稳定 ID；原生 session resolver 的历史注入不由此规则改写。

交接提示同时说明当前会话与目标工作区的职责、用户本次任务及执行状态。对于“@工作区 给他发送一个你好”，明确将“你好”作为目标 agent 的任务；唯一目标可用时直接给出该 target 的调用示例。目标未配置、引用无法解析、工具不可调用是三个不同状态，分别给出原因，不仅返回项目路径让模型猜测。只有引用而没有任务时不主动委派。此提示不会自动填充 profile 的 targets，也不会绕过目标运行配置。

本地路径新增 API 契约 + 真实 agent loop 测试（模型 fixture），覆盖空 targets 的 query→调用→结果回流、工作区归属、会话继续及取消竞态。当前缓存的 apiproxy 实现与其 api-remotes 依赖不兼容，故测试替换宿主 API 边界，未声称完成真实宿主 API 或供应商验收。插件运行时只使用宿主提供的 API，新增依赖仅用于类型检查，不加载另一份 API 实现。

## 已发送消息的工作区引用

新引用使用 `@workspace-ref/<base64url JSON>`，JSON 仅含 `{id,label}`；名称是显示快照，委派始终按 ID 查注册表。选择、拖放、复制与发送保留同一身份。旧 `@workspace-id/<id>` 继续可用，旧草稿经过 codec 发送时可补齐名称。

DSH conversation 声明通用 chain slot `conversation.message.reference`；默认条目绘制官方 chip，本插件仅接管工作区引用。输入框之外的用户消息和 steering 消息共用该入口。当前名称从 `useWorkspaces` 读取，移除后的新引用使用名称快照；没有快照的旧引用显示“工作区不可用”。hover 展示项目名称和目录，不展示 UUID。复制消息保留原始引用，渲染不修改历史或委派参数。

需要同时加载带上述 slot 的 DSH conversation bundle 与本插件 bundle；仅更新插件无法为旧宿主补出该入口。
