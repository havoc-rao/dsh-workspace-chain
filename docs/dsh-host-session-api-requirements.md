# dsh 本体：Host Session API 契约需求文档

> 提出方：`dsh-workspace-chain` 插件（本地路径 `/Users/havoc/Documents/Projects/tools/dsh-plugins/dsh-workspace-chain`）
> 日期：2026-09-12
> 目标：让 deepseek-harness 本体把"宿主侧会话控制 API"稳定为受支持的 Host Plugin API，并补齐委派类插件需要的两个信息缺口。

---

## 1. 背景与根因（为什么"DSH 本地会话 API"不可用了）

`dsh-workspace-chain` 通过宿主上下文提供的一个会话控制服务来创建/续跑/交付/取消**宿主真实会话**（与 UI 同构的会话，而不是 SDK 子进程）。该服务此前是 `ctx.apiProxy`（`@deepseek-ai/dsh-host-apiproxy` 包的 gateway 插件）。

排查结论：

- 本体版本：`deepseek-harness` master，`@deepseek-ai/dsh-root` `0.1.5-rc.2`（`~/.local/share/mise/installs/dsh/dev/bin/dsh` → `apps/cli/lib/bin.js`）。
- 根因 commit：`4f00a8b82a` `refactor(api): remove ApiProxy package`（2026-08-27，作者 imccyu），整体删除 `packages/host/apiproxy`（-3529 行，含 `ctx.apiProxy` 提供方、Web bundle `cordis.patch.yml` 的 `api-gateway` 行、`dsh-tool-cordis` api-catalog 引用）。同批迁移把会话路由落入 `packages/api/*`：`dsh-api-gateway`（Typert Remote 分发）、`dsh-api-session-controller`（namespace `session`）、`dsh-api-remotes` 等。
- 后果：web profile（`~/.dsh/profiles/web`）中旧包 symlink `dsh-host-apiproxy → apps/electron/.../dsh-host-apiproxy` 已悬空；`ctx.get('apiProxy')` 恒为 undefined，插件的引用委派提示为"DSH 本地会话 API 不可用"。
- 新契约已存在且可用：web-app bundle 已挂 `- id: session-controller name: '@deepseek-ai/dsh-api-session-controller'`（HEAD `packages/bundle/web-app/cordis.patch.yml`），宿主侧可直接调用 `ctx.sessionController.{list,create,rename,prompt,cancel}`（e2e 已有 `scaffold.ctx.sessionController.*` 先例）。**本次"不可用"不是本体缺能力，而是旧契约被退役、插件未跟随。** 插件已在 2026-09-12 迁移到新契约（见 §3 映射表）。

因此，本需求文档的主要诉求从"恢复 apiProxy"调整为两件事（§2）：**把新契约声明为受支持的 Host Plugin API**，以及**补两个信息缺口**（list 摘要的 `agentPreset`、prompt 的 `requestId` 语义）。

---

## 2. 需求清单（本体侧）

### R1（必须）：将 `ctx.sessionController` 声明为受支持的 Host Plugin API

现状：`session-controller` 行仅在 web-app bundle patch 中按实现细节挂载；`SessionController` 的类型与 Context augmentation 存在，但没有任何"插件可消费"的契约文档或稳定性承诺。宿主平面任意插件（host 侧 `ctx`）应可依赖：

- 服务名：`sessionController`（`ctx.get('sessionController')`，类型 `SessionController`）；
- 方法面（保持现状签名即可，需文档化承诺）：
  - `list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue>`；
  - `create(request: SessionCreateRequest): Promise<SessionCreateValue>`（含 `workspaceId | cwd` 二选一、`sessionId` 显式 ID 幂等 adopt、`agentPreset` 组合名）；
  - `rename(request: SessionRenameRequest): Promise<SessionRenameValue>`；
  - `prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>`（`mode: 'queue' | 'steer'`）；
  - `cancel(request: SessionCancelRequest): SessionCancelValue`（语义：取消活跃回合、**保留 inbox**）；
  - `inspect(sessionId, signal?)`、`resolveAgent(sessionId)`（插件做存在性/归属校验用）。
- 错误面：`RemoteError` code 集合（`session/not-found`、`session/model-unavailable`、`session/workspace-attach-failed`、`workspace/not-found`、`gateway/bad-request` 等）进入官方文档；版本升级不得未经 major 变更就删方法或改语义（至少遵守 semver：删方法 = breaking）。

交付物建议：`packages/api/session-controller/README.md` 增加 "Host-side plugin consumption" 一节 + 一个 `HostSessionApi` 接口类型（与 Remote 签名一致），并把 `sessionController` 从"内部实现细节"提升为 bundle patch 的注释承诺。

### R2（必须，信息缺口）：`SessionSummary` 恢复暴露 `agentPreset`

委派类插件的语义是"子会话继承父会话当前 preset"。旧契约 `sessions.list` 的 `SessionSummary.agentPreset` 提供该读法；新 `SessionSummary`（`packages/api/session-controller/src/types.ts:163`）只有 `sessionId/updatedAt/running/blank/parentSessionId/origin/cwd/projections`，**不再有 agentPreset**。

当前插件绕过方式是读 live 父会话 `parent.session.header.agentPreset`——这只对 live 会话成立（header 是创建时值，preset 切换后由 `agentPreset` projection 更新），冷会话/持久化摘要没有公开途径。

请求：在 `SessionSummary` 增加 `readonly agentPreset?: string`（live 分支取 session header/当前 projection，冷分支取持久化投影 `agentPreset`；同 `dsh-session-projection` 已有 `agentPresetProjectionDefinition` 一致）。这同时恢复 UI/第三方读列表即可知 preset 的能力。

### R3（必须，语义文档化）：`prompt.requestId`

新 `SessionPromptRequest.requestId: SessionRequestId` 为**必填**（旧契约无此字段），宿主持久化在接受的 user message 上并做幂等去重（`hasPromptRequest`）。这是相对旧契约的破坏性变更：

- 请求：进入 release notes / 迁移指南；文档说明 requestId 生命周期（谁 mint、重复提交同一 id 的语义、失败重试是否应复用 id）。
- 插件已适配（每次交付 mint 一个 UUID），但其他客户端（含浏览器侧）应有明确契约。

### R4（应当）：create 显式 `sessionId` 的幂等 adopt 契约文档化

旧插件曾为"宿主不支持预分配 id"保留回退；新 `create` 原生支持 `sessionId`（`ensureSession(sessionId, cwd, adopt=true, preset)`，已存在会话则 adopt 不重建）。这是「会话 ID 调用时预分配 → 后台响应/委派记录即时携带 → 后续 session_id 续跑」链路的前提。请求：将该语义（显式 id + 同 workspace → 同一会话）写入官方文档，并保持稳定。

### R5（应当）：可选过渡兼容层

不建议把 `dsh-host-apiproxy` 恢复进 core（迁移方向明确且已完成）。可选项（按成本排序，任一即可）：

1. 本体在 `docs` 给一篇 "apiProxy → sessionController 迁移指南"（§3 映射表可直接采用）；
2. 或由本体/社区提供一个 profile 级 shim 插件（`ctx.apiProxy` 兼容面包装 `sessionController`，作为老插件的过渡桥），不进入 core 包。

### R6（应当）：错误码与可读性

插件依赖 readable cause（"被拒/不存在/忙"区分）。请求：`RemoteError` code 集合加入官方 API 文档；`session/not-found` 等错误在插件侧按 code 分支（当前插件按 message 匹配，脆弱）。

---

## 3. 迁移映射表（旧契约 → 新契约），供本体文档与老插件作者使用

| 旧（已删除） | 新（0.1.5-rc.2） | 差异 |
| --- | --- | --- |
| `ctx.get('apiProxy')` | `ctx.get('sessionController')` | 服务名更换；availability 探测方式不变 |
| `api.sessions.list({})` | `controller.list({}, signal)` | 加 signal；`items[].agentPreset` 缺失（R2）；`SessionListRequest` 有可选 `cursor` |
| `api.sessions.create({ workspaceId, agentPreset, sessionId? })` | `controller.create({ workspaceId, agentPreset, sessionId? })` | 除去 rpc 信封；显式 `sessionId` 原生 adopt（不再需要回退分支）；`workspaceId` 与 `cwd` 二选一 |
| `api.sessions.rename({ sessionId, title })` | `controller.rename({ sessionId, title })` | 返回 `{title, seq}`（无信封） |
| `api.sessions.prompt({ sessionId, mode: 'queue', content })` | `controller.prompt({ sessionId, mode: 'queue', requestId, content }, signal)` | **新增必填 `requestId`**（`SessionRequestId`，每次交付 mint UUID）；加 signal |
| `api.sessions.cancel({ sessionId })` | `controller.cancel({ sessionId })` | 同步返回 `{accepted:true}`；语义同（取消活跃回合、保留 inbox） |
| 错误：RpcResult `{ok:false, error}` | 直接 throw `RemoteError` | 调用方 catch 即可 |

---

## 4. 验收标准

1. **R1**：任意第三方插件在 web profile 的 host 平面中 `ctx.get('sessionController')` 返回服务；文档存在且方法面与类型一致。
2. **R2**：`sessionController.list()` 的 live 会话项带 `agentPreset`；冷摘要与 `agentPreset` projection 一致。
3. **R3/R4**：文档与 release notes 覆盖 `requestId` 与显式 id adopt 语义。
4. 端到端：`dsh-workspace-chain` 迁移版在重启后的 web profile 中对已登记工作区执行一次引用委派——`delegate_workspace` 返回预分配 `sessionId`、任务在目标工作区新会话中完成、`session_id` 续跑命中同一会话、取消保留 inbox。

附：本机复现路径

```sh
# 宿主源码
ls /Users/havoc/Documents/Projects/tools/deepseek-harness
git -C /Users/havoc/Documents/Projects/tools/deepseek-harness show 4f00a8b82a --stat
# profile 引用
cat ~/.dsh/profiles/web/package.json   # dsh-workspace-chain: link:...
cat ~/.dsh/profiles/web/cordis.patch.yml
```