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
- `dcf init` 支持 vite、tsdown、cordis 接线。本仓库使用 `scripts/build-client.mjs` 的自定义 esbuild 构建，不能假定 CLI 会自动完成构建期注入；需检查接线与产物。
- 独立产物注入命令为 `NODE_ENV=development dcf instrument lib --write`。它修改生成文件，后续 build 会覆盖；不要把产物位置误报为原始 TSX 精确位置。
- 接入完成后，在页面按住 **Opt+Shift / Alt+Shift** 悬停组件检查源码定位。CLI 安装、profile 挂载、项目构建期注入是不同状态，分别确认。
- `dcf remove --cwd .` 会移除接线及依赖，仅在明确需要卸载时使用。

### 已确认状态（2026-09-06）

- 本机 `dcf` 可用，DSH `web` profile 已链接上述本地工具仓库。
- 相邻 `dsh-enhanced-workspace` 已接入 dcf 构建插件及 runtime。
- 当前 `dsh-workspace-chain` 尚未接入 dcf。单独运行 `NODE_ENV=development pnpm build` 不会自动补齐接入；后续接入完成时更新此记录。

## 委派记录协议（改动时必须保持的不变量）

- 每次 `delegate_workspace` 调用（前/后台、本地/SDK）在目标工作区写 `<workspace>/.dsh/delegations/<delegationId>/`：`task.md`（人类可读任务书）、`task.json`（结构化）、`progress.md`（checkpoint 日志）、`resume.md`（恢复指引+续跑样例）。`delegationRecords: false` 关闭时完全恢复旧行为（任务原文原样交付）。
- 记录写入是 best-effort：目标目录不可写时委派继续，无 checkpoint 降级，不得因此失败。
- 结算分类取值固定：`completed | timeout | cancelled | crash | host-reclaim | refused | max-tokens | failed`（与父侧分析文档契约对齐，`failed` = unknown 槽）。分类依赖我方信号状态（deadline 触发 vs 调用方信号中止），不只是 child stopReason。
- 会话标题固定（本地路径）：`sessions.create` 无 title 字段，创建后经 `sessions.rename` 固定标题。默认=任务摘要（`deriveDelegationTitle`：任务首行去格式后截断 40 字符，**不拼工作区名**——会话已在工作区分组下）；显式 `title` 参数优先（可传 `类别/任务` 如 `绘画/画一只猫`）。`pinnedTitles: false` 关闭。rename 是 best-effort：老宿主无该 RPC 或标题被拒只记 progress 行，不得失败委派。SDK 子进程无宿主会话，标题只写入任务书。
- `record.title` 与传给 `sessions.rename` 的标题必须一致（`pinnedTitles: false` 时只记录不 rename）。
- 后台 job 必须提供 `readOutput`：运行中返回 progress.md 摘要，结算后返回最终输出（保持"运行中有可见性、结算有最终结果"两侧语义）。
- 前台/后台失败消息与 job detail 必须包含：Classification、transcript 位置（`sessionStoreHint`）、Checkpoint/Task/Resume 三路径、elapsed。
- 工具参数与返回只能扩展（如 `timeout_ms`、`delegationId`、`checkpointPath`），不得破坏旧字段。
