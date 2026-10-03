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

1. 每个目标挂独立 SDK provider；profile/patches/dshHome/cwd 不属于 start-time 请求。
2. npm 发布 API 与本地源码不同。核心使用 0.1.7-rc.2，SDK provider/client 与 Web 类型包同步 0.1.7-rc.2。弃用不兼容的旧 spine bundle，child-runtime 直接组合相同版本的核心服务。
3. 关闭共享时显式传独立 DSH_HOME，避免默认 ~/.dsh 导致串 store。
4. R2 **部分验证，UI 自动归属未实现**：同 store 与 cwd 成立；SDK provider 的父 run ID 与 child 持久化 session ID 不同，后者没有公开映射。真实 registry 挂接实验因该差异失败，最终不发布错误 ID、不展示虚假会话入口。测试固定这一限制。
5. 默认持久化使用 zstd；测试为检查 JSONL 内容显式覆盖 none。自定义父 sessions 路径或编码必须由 child 配置对齐。
6. query 识别不是独立 LLM classifier：确定性引用/名称/别名/追问匹配负责 hint，A 结合 system catalog 作语义委托决策。工具随非空配置注册。

## 待验收 / 限制

- 无浏览器连接：已测 DOM 与点击，未做实际 DSH Web 视觉验收。
- 未使用真实模型 API key；真实组合中的模型是确定性适配器。
- SDK 暴露 child session ID 后，才能可靠实现自动工作区 membership 和子会话链接。

## 2026-09-06：引用层级与侧栏联动

- `@` overlay slot 新组件：本项目 → workspace 本身 / session → fork，其他来源独立分组；支持当前层级搜索与分类列表。
- workspace/session 引用区接收侧栏拖放；侧栏补丁位于相邻 `dsh-enhanced-workspace` 仓库。
- 宿主解析稳定 workspace ID 并注入上下文；仅已配置目标可委托。Session 沿用原生引用格式。
- 新增 UI、协议、搜索范围、层级关系和 host hint 测试。侧栏 39 项组件测试通过，开发构建完成。
- 仍未完成真实 DSH 页面视觉验收，也未修改或重新挂载用户的 profile。

后续更新：已将本地插件链接并登记到 web profile；全屏引用拖放与输入栏小型 @ 入口已实现。新增输入框引用 hover 原始信息预览，以及 workspace/session → 实际可见工具参数的宿主提示映射。委托始终创建新会话，不会恢复所引用的 session/fork。仍未完成真实页面视觉验收。

工具呈现更新：移除 workspace-chain system section；后端工具保留注册，但从顶层 schema 和生成的 SDK system section 中排除。调用说明仅在命中 query/引用后的消息中追加，模型直接发出 delegate_workspace 原生 tool-call。已移除对 run_code 的调用依赖，不修改宿主工具模式。组合测试覆盖 native/both 的挂载前后前缀相等，以及后续 hint → 原生委派调用 → 实际 SDK 子会话 → 结果整合；模型是确定性 fixture，实际供应商对未列入顶层 tools 的调用能力仍待验证。当前 web profile 的 targets 仍为空，必须配置目标后才有实际委派能力。

针对 session 2 日志：原始输入“@workspace-id/... 给他发送一个你好”只获得项目元信息，未获得调用说明，原因是当前 targets 为空。现已补充任务交接场景、可执行/未配置/不可调用的明确状态，以及唯一目标可用时的具体调用参数；native 模式的真实 SDK 组合测试已覆盖该原始输入，模型仍使用确定性 fixture。39 项测试通过。


## 2026-09-06：默认切换为宿主本地会话 API

上述“空 targets 不可委派”和 SDK 会话归属限制不再适用于默认路径。插件现在始终注册工具，已登记工作区按精确路径解析，通过宿主 sessions.create / prompt / cancel 创建、交付和取消任务；create 负责 workspace membership 与 preset。会话结束后保留，使用宿主新会话默认模型，继承父当前 preset。显式 SDK targets 继续走原有独立进程路径。

后续消息的调用声明及顶层 system/tools 前缀隔离保留。增加 API 契约边界 + 真实 loop 的全链路测试，以及 preset 参数、创建/发送失败、取消与发送竞态测试。缓存 apiproxy 的传递依赖存在版本冲突，API 实现本身没有在测试中加载；真实宿主和真实供应商仍待联调。未重新挂载 profile。

## 2026-09-06：委派体验修复（对照 dsh-enhanced-workspace/docs/delegation-experience-analysis.md）

针对父会话三次 `workspace delegation ended: aborted` 现场（无分类、无日志路径、无过程输出、任务书丢失、无法干预）落地：

- **委派记录 + checkpoint 协议**：每次委派写 `<workspace>/.dsh/delegations/<delegationId>/{task.md, task.json, progress.md, resume.md}`；任务书信封向目标会话声明进度协议（每完成一个可验证步骤 append 一行）；`delegationRecords: false` 关闭恢复旧行为；目录不可写 best-effort 降级。
- **结构化失败诊断**：分类 `completed | timeout | cancelled | crash | host-reclaim | refused | max-tokens | failed`（对齐父侧契约，failed 为 unknown 槽）；前台错误与后台 job detail 均含 Classification/（SDK run id 或本地 session id）/transcript 位置（宿主或 child session store）/Checkpoint/Task/Resume 路径/elapsed；`DelegationFailure.diagnostic` 供程序化消费。
- **过程可见性**：后台 job 提供 readOutput——运行中 job_output 返回 progress 摘要，结算后返回最终输出；native 路径在 session 创建/任务交付/取消请求处打生命周期 checkpoint。
- **等待语义**：区分顶层 `tool-jobs` 的两种返回（wait 上限到点 → `[status: running]`+摘要；`Error: wait aborted` → 父侧信号被宿主中止，任务仍在跑）；前台/后台超时统一由 `timeout_ms`（默认 defaultTimeoutMs）约束并在诊断中标注 elapsed；新参数仅扩展兼容。
- **可恢复性**：task/resume 持久化即恢复入口；resume.md 含续跑指引与样例任务书；宿主保留会话的找回路径写入诊断。
- **会话标题固定**：确认 `sessions.create` 无 title 字段、宿主提供 `sessions.rename`（追加 `session/title` 事件并 pin 住自动再生成）；创建后立即 rename。默认标题=任务摘要（`deriveDelegationTitle`：任务首行去格式后截断 40 字符，不拼工作区名——会话已在工作区分组下，用户反馈前缀冗余）；想要 `类别/任务`（如 `绘画/画一只猫`）可显式传 `title`；`pinnedTitles: false` 关闭。rename 为 best-effort（老宿主无该 RPC / 标题被拒只记 progress 行）；SDK 子进程无宿主会话，标题只写入任务书。任务书同步记录 `title`（task.md 表行 + task.json 字段）。
- 测试：新增 delegation-record 专项（含 deriveDelegationTitle 格式/截断/去格式用例）与 tool 层分类/等待/readOutput/降级/title 用例；native 生命周期新增 rename 固定/失败容忍/缺省跳过；native 集成测试断言 `Target/not-a-command` 风格标题经真实 rename RPC 固定且入任务书。67 项全绿，typecheck/build 通过。
- 未完成：P6 宿主侧核查（会话回收策略、父侧信号中止条件、tool-jobs wait 配置）与真实页面视觉验收；记录在 README"宿主侧待核查"。

## 2026-09-07：长任务并行体验 + 活动感知超时

背景：委派超时目前是硬 deadline（300s 到点即 cancel 子会话），但委派任务经常确实耗时（对方仍在正常工作），且链式任务常可并行（如只等对方返回一个 key/契约名即可续接）——并行部分应挂后台、主流程继续，最后 join 结果。

- **并行调度 prompt**：`delegate_workspace` 工具描述与 invocation hint（含工作区交接提示）明确决策规则——同一请求可拆的互不依赖子任务（只等对方返回 key/契约名、改动互不干扰的多个工作区）一律 `run_in_background: true` 挂后台继续其他工作，最后统一 `job_output` 收取；只有下一步必须依赖其结果时才前台等待。
- **活动感知超时**（替换硬 deadline，`src/patience.ts` `adaptiveDeadline`）：新增配置 `timeoutExtensionMs`（默认 120000ms）、`maxTimeoutExtensions`（默认 10）。base 窗口（`timeout_ms`/`defaultTimeoutMs`）到点后探测目标会话活动——本地 agent `status === 'running'`、`<DSH_HOME>/sessions` 近期写入、progress.md 有目标侧 `- ` checkpoint 行（插件 `[init]`/`[start]`/`[extend]` 生命周期行不算）——任一命中顺延一轮，`[extend] target still active (…)` 写入 progress（`job_output` 可见）；持续静默或轮数用尽才按 `timeout` 结算，诊断 detail 附最后观测活动与停等时长。调用方信号中止时探测定时器停止（不把 cancelled 误判 timeout）。
- **任务书活跃心跳**：`composeTask` 信封增加长耗时步骤（构建/测试/等待外部结果）开始时追加 `- <步骤>…` 的协议，并告知目标侧超时语义，让"对方还在正常工作"可被观测。
- 测试：新增 patience 单测（顺延/静默/上限/取消竞态/探测判定）与 tool 层用例（live agent 顺延后完成、session-store 心跳顺延后静默超时、扩展上限、hint 文案）、config 新字段校验；tool fixture 改为隔离 DSH_HOME 避免探测读到真实 home。typecheck/build 通过，83 项测试全绿。
- 未完成：真实长任务现场验收（前台/后台各一次观察 `[extend]` 顺延与静默超时）；README"宿主侧待核查"开放项不变。

## 2026-09-12：迁移到宿主 sessionController（原 apiProxy 网关已从本体移除）

背景：引用工作区（如 @DSH-code-finder）触发“DSH 本地会话 API 不可用”提示——不是宿主故障，而是插件消费的旧宿主角落在 0.1.5-rc.2 中不存在。

- **根因**：deepseek-harness commit `4f00a8b82a`（2026-08-27 `refactor(api): remove ApiProxy package`）整体删除 `packages/host/apiproxy`（含 `ctx.apiProxy` 服务与 Web bundle 的 api-gateway 行，-3529 行）；替代品是 `packages/api/*`（Typert Remote）：`dsh-api-session-controller`（namespace `session`）等。web profile 已挂 `session-controller` 行，宿主侧可直接调用 `ctx.sessionController`。
- **迁移**：`src/native.ts` 从 `ctx.get('apiProxy').sessions.*`（rpc 信封）改为 `ctx.sessionController.{list,create,rename,prompt,cancel}`（普通请求对象；`list/prompt` 附 signal；prompt 新增必填 `requestId`）。会话 ID 预分配 adoption 由新 create 原生支持，删除“宿主拒绝预分配则回退”分支与 `createSession` 封装。父 preset 改为直接读 `parent.session.header.agentPreset`（新 list 摘要不再暴露 agentPreset）。
- **可用性门**：`workspace-hints.ts`/`catalog.ts` 的 `nativeAvailable` 改为 `ctx.get('sessionController') !== undefined`；peer 依赖 `dsh-host-apiproxy` 换成 `dsh-api-session-controller >=0.1.5-rc.2`（optional，类型仅 devDeps 引用）。
- **测试**：native 单测/集成 mock 从 `{rpcId, result}` 信封改为 plain 契约；删除“预分配回退”用例；断言适配 prompt 双参签名。typecheck/build 通过，96 项测试全绿。
- **未完成**：宿主进程重启后真实验收（重启 web profile 使新 lib 生效，再对已登记工作区跑一次引用委派）；`docs/dsh-host-session-api-requirements.md` 为本体侧稳定契约的需求清单。

## 2026-09-12：delegate_workspace 默认进入顶层工具 schema（visibleTools）

背景：宿主迁移到 `sessionController` 后，本会话（Claude 系模型）仍无法调用委派工具——deferred 模式的文本声明进不了顶层 schema，模型端 tool-call 校验拒绝 schema 之外的函数名；DeepSeek 原生 loop 按名路由可用，但不能作为通用假设。

- **`visibleTools` 配置（默认 true）**：`delegate_workspace` 保留在 `system-prompt/assemble` 产出的 `assembly.tools` 与 `tools:sdk` 段，任何模型都把它当普通工具直接调用；`visibleTools: false` 恢复 deferred 模式（剥离 schema，仅注入文本声明 + 宿主按名路由）。
- **提示文案分支**：`invocationHint` 按模式说明"已注册在顶层 tools"或"未列在顶层 tools，通过原生 tool-call 调用"；其余用法/并行/超时/回话语义不变。
- **测试**：config 新增默认值/关闭/类型校验用例；组合测试新增可见模式断言（mount 后 `assembly.tools` 含 `delegate_workspace`，native 呈现模式）；native/组合原有前缀相等断言显式传 `visibleTools: false` 保持其"隐藏模式"语义。typecheck/build 通过，97 项测试全绿。
- **未完成**：重启 electron 后真实会话验收（本会话工具表应直接出现 `delegate_workspace`，引用委派可被实际调用）。

## 2026-09-23：移除输入框引用 UI（仅保留拖放）

按用户要求瘦身输入区能力：移除「chain 核心的上下文注入」（输入框 `@` 引用菜单/候选/按钮）与「针对 input 区域的 tips 优化」（输入框 chip hover 预览），只保留关键基础能力（工具描述即 agent 上下文 + 纯执行基础）。

- **删除**：`src/client/ReferenceMenu.tsx`（`conversation.input.overlay` 的 `slash-menu` 候选菜单与层级导航）、`src/client/source.ts`（inputTriggers `@` 候选源）、`src/client/ReferencePreview.tsx`（chip hover 原始信息提示气泡）、`src/client/reference-tree.ts`（仅菜单使用的层级树）。
- **保留**：`ReferenceDock` 拖放（全屏遮罩、实时列表校验、revision 校验插入，去掉 `@` 按钮与 `open`），`WorkspaceMessageReference` 消息内引用渲染，`DelegationRow`/`EscalationDelegation`/`toolview-slot`，以及全部服务端注入（workspace-hints/hints/intent/denial-hint/presentation）不动。客户端 `inject` 去掉 `inputTriggers`，宿主原生 `@` 菜单恢复。
- **测试**：移除 source/菜单/预览/tree 用例 7 项；拖放用例保留并去掉按钮断言。typecheck 通过，119 项测试全绿；dev 构建 dcf 注入 102 处（原 140 处）。
- **未完成**：真实页面视觉验收（拖放路径未在浏览器实测）。
