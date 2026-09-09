# 开发指导

## 开发构建与验证

- 完成一个 UI 功能点后，运行 `NODE_ENV=development pnpm build`，生成用于本地联调的客户端 bundle。
- 类型检查使用 `pnpm typecheck`；行为验证使用 `pnpm test`（包含构建）。
- 构建成功不等于已重新挂载 DSH profile，也不等于完成真实页面验收；报告结果时明确区分。

## dcf：组件源码定位 CLI

本地工具仓库：`/Users/havoc/Documents/Projects/tools/DSH-code-finder`。
CLI 名为 `dcf`，也可使用 `dsh-code-finder`。接入文档见该仓库的 `README.md` 和 `docs/README.md`。

常用命令（在目标插件仓库执行）：

```sh
# 检查接线状态及构建产物的注入情况
dcf status --cwd .

# 需要接入时，使用本地源码包，避免从 registry 下载未发布版本
dcf init --cwd . --link /Users/havoc/Documents/Projects/tools/DSH-code-finder

# 已有本项目依赖时，只接线，不重复安装
dcf init --cwd . --no-install

# 接线完成后进行开发构建
NODE_ENV=development pnpm build
```

- 接入前先运行 `dcf status`，按实际缺失项处理，避免反复执行 install。
- `dcf init` 支持 vite、tsdown、cordis 接线。本仓库 client bundle 由 `tsdown.config.ts` 构建（双产物 `lib/client.js` + `lib/client-registry.js`，参照 DSH 官方 client-bundle preset），已接入 `codeFinderTsdown()` 构建期注入：dev 语义（`NODE_ENV=development`）下在源码 transform 阶段注入 `data-locatorjs`，位置指向**原始 TSX**；生产语义（`NODE_ENV=production`）零注入。`dcf status` 用 `data-locatorjs` 计数抽查产物。
- `cordis.patch.yml` 是插件型 patch（仅 insert 块），`dcf init` 明确跳过挂载 code-finder 插件——overlay runtime 由宿主 DSH web profile 提供（本机已链接工具仓库）；`dcf status` 对该项显示 ✗ 属预期，不是缺失。
- 本机 shell 预设 `NODE_ENV=development`（含构建子进程）；验证生产语义需显式 `NODE_ENV=production pnpm build`。
- 本机 pnpm 默认 store 解析为项目本地 `.pnpm-store`，与现有 node_modules 的全局 store（`~/.local/share/pnpm/store/v11`）不一致：`pnpm add/remove/install` 需带 `--store-dir /Users/havoc/.local/share/pnpm/store/v11`，否则 `ERR_PNPM_UNEXPECTED_STORE`；`dcf init` 的依赖安装也会因此失败，先手动 `pnpm add -D --store-dir ... link:<工具仓库>` 再 `dcf init --cwd . --no-install`。
- 接入完成后，在页面按住 **Opt+Shift / Alt+Shift** 悬停组件检查源码定位。CLI 安装、profile 挂载、项目构建期注入是不同状态，分别确认。
- `dcf remove --cwd .` 会移除接线及依赖，仅在明确需要卸载时使用。

### 已确认状态（2026-09-06）

- 本机 `dcf` 可用，DSH `web` profile 已链接上述本地工具仓库。
- 相邻 `dsh-enhanced-workspace` 已接入 dcf 构建插件及 runtime。
- `dsh-workspace-chain` 已接入 dcf：依赖 `@havocrao/dsh-code-finder`（link 本地仓库）+ `tsdown.config.ts` 的 `codeFinderTsdown()` 构建期注入（原始 TSX 位置）。`NODE_ENV=development pnpm build` 后 `dcf status` 显示注入 140 处；页面 Opt+Shift 悬停可定位到 `src/client/*.tsx`。client bundle 构建已从 `scripts/build-client.mjs`（自定义 esbuild）迁移到 tsdown。

## 委派记录协议（改动时必须保持的不变量）

- 每次 `delegate_workspace` 调用（前/后台、本地/SDK）在目标工作区写 `<workspace>/.dsh/delegations/<delegationId>/`：`task.md`（人类可读任务书）、`task.json`（结构化）、`progress.md`（checkpoint 日志）、`resume.md`（恢复指引+续跑样例）。`delegationRecords: false` 关闭时完全恢复旧行为（任务原文原样交付）。
- 记录写入是 best-effort：目标目录不可写时委派继续，无 checkpoint 降级，不得因此失败。
- 记录根目录 `<workspace>/.dsh/` 首次生成记录时附带 `.gitignore`（`*` + `!.gitignore`），委派产物不进目标仓库 git 跟踪、只有忽略文件本身入库；已有用户管理的该文件不覆盖，写入失败不影响委派（best-effort）。
- 结算分类取值固定：`completed | timeout | cancelled | crash | host-reclaim | refused | max-tokens | failed`（与父侧分析文档契约对齐，`failed` = unknown 槽）。分类依赖我方信号状态（deadline 触发 vs 调用方信号中止），不只是 child stopReason。
- 会话标题固定（本地路径）：`sessions.create` 无 title 字段，创建后经 `sessions.rename` 固定标题。默认=任务摘要（`deriveDelegationTitle`：任务首行去格式后截断 40 字符，**不拼工作区名**——会话已在工作区分组下）；显式 `title` 参数优先（可传 `类别/任务` 如 `绘画/画一只猫`）。`pinnedTitles: false` 关闭。rename 是 best-effort：老宿主无该 RPC 或标题被拒只记 progress 行，不得失败委派。SDK 子进程无宿主会话，标题只写入任务书。
- `record.title` 与传给 `sessions.rename` 的标题必须一致（`pinnedTitles: false` 时只记录不 rename）。
- 后台 job 必须提供 `readOutput`：运行中返回 progress.md 摘要，结算后返回最终输出（保持"运行中有可见性、结算有最终结果"两侧语义）。
- 前台/后台失败消息与 job detail 必须包含：Classification、transcript 位置（`sessionStoreHint`）、Checkpoint/Task/Resume 三路径、elapsed。
- 超时是活动感知的（`src/patience.ts` 的 `adaptiveDeadline`，不得退回硬超时）：`timeout_ms`（默认 `defaultTimeoutMs`）到点后若目标会话仍有产出——本地 agent `status === 'running'`、`<DSH_HOME>/sessions` 近期写入、progress.md 出现目标侧 `- ` checkpoint 行（插件自身 `[init]`/`[start]`/`[extend]` 行不算）——按 `timeoutExtensionMs` 顺延一轮，累计上限 `maxTimeoutExtensions` 轮；持续静默或轮数用尽才按 `timeout` 结算。调用方信号中止时探测定时器必须停（不得把 cancelled 误判成 timeout）。
- 任务书进度协议支持活跃心跳：长耗时步骤（构建、测试、等待外部结果等）开始时也追加一行 `- <步骤>…` 并周期性更新，让父侧可观测"对方仍在工作"。
- 工具参数与返回只能扩展（如 `timeout_ms`、`delegationId`、`checkpointPath`），不得破坏旧字段。
