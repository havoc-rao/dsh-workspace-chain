import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Delegation record: a durable, on-disk task book plus a checkpoint protocol
 * that survives aborts, host restarts and lost job ids.
 *
 * Layout per delegation (created under the TARGET workspace, so any session
 * in that workspace — including a fresh resume session — can read it):
 *
 *   <workspace>/.dsh/delegations/<delegationId>/
 *     task.json    task book (task text, target, parent, timestamps, session id)
 *     progress.md  checkpoint log; the child appends one line per verifiable step
 *     resume.md    recovery instructions + a ready-made resume task book sample
 *
 * All writes are best-effort from the caller's perspective: a workspace the
 * plugin cannot write to degrades to the previous behaviour (delegation still
 * runs, just without the checkpoint protocol).
 */

export const DELEGATION_ROOT = join('.dsh', 'delegations')
export const TASK_FILE = 'task.md'
export const TASK_JSON_FILE = 'task.json'
export const PROGRESS_FILE = 'progress.md'
export const RESUME_FILE = 'resume.md'

export type DelegationMode = 'local' | 'sdk'

export interface DelegationRecord {
  delegationId: string
  mode: DelegationMode
  /** Display identity of the target (absolute workspace path or SDK target name). */
  target: string
  /** Absolute target working directory (where the record is written). */
  workspacePath: string
  parentSessionId: string
  createdAt: string
  task: string
  /** Pinned session title (`<project>/<task summary>` by default, or the caller's explicit title). */
  title?: string
  timeoutMs?: number
  sessionId?: string
  runId?: string
  dir: string
  /** Human-readable task book (task.md). */
  taskPath: string
  /** Structured task book (task.json). */
  taskJsonPath: string
  progressPath: string
  resumePath: string
}

export interface WriteDelegationRecordInput {
  delegationId: string
  mode: DelegationMode
  target: string
  workspacePath: string
  parentSessionId: string
  createdAt: string
  task: string
  title?: string
  timeoutMs?: number
  sessionId?: string
  runId?: string
}

export function newDelegationId(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `dlg-${stamp}-${randomUUID().slice(0, 8)}`
}

export function recordDir(workspacePath: string, delegationId: string): string {
  return join(workspacePath, DELEGATION_ROOT, delegationId)
}

function recordFiles(dir: string) {
  return { taskPath: join(dir, TASK_FILE), taskJsonPath: join(dir, TASK_JSON_FILE), progressPath: join(dir, PROGRESS_FILE), resumePath: join(dir, RESUME_FILE) }
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19)
}

/** Write the task book, progress header and initial resume note. Throws on fs failure; callers decide how to degrade. */
export function writeDelegationRecord(input: WriteDelegationRecordInput): DelegationRecord {
  const dir = recordDir(input.workspacePath, input.delegationId)
  const files = recordFiles(dir)
  mkdirSync(dir, { recursive: true })
  const record: DelegationRecord = { ...input, dir, ...files }
  writeTaskJson(record)
  writeTaskMarkdown(record)
  const header = [
    `# 委派进度 · ${record.delegationId}`,
    `工作区: ${record.workspacePath}`,
    `创建: ${record.createdAt}`,
    '协议: 每完成一个可验证步骤，追加一行 `- <步骤简述>`；任务结束时追加 `- [result] <结果摘要>`。不要改写已有行。',
    '',
  ].join('\n')
  writeFileSync(record.progressPath, header)
  appendLine(record, '[init] delegation record created')
  writeResumeNote(record, 'running')
  return record
}

function writeTaskJson(record: DelegationRecord): void {
  writeFileSync(record.taskJsonPath, `${JSON.stringify(record, null, 2)}\n`)
}

/** Human-readable task book: full task text plus the delegation metadata a resume session needs. */
function writeTaskMarkdown(record: DelegationRecord): void {
  const markdown = [
    `# 委派任务书 · ${record.delegationId}`,
    '',
    `| 字段 | 值 |`,
    `| --- | --- |`,
    `| 目标 | \`${record.target}\` |`,
    `| 工作区 | \`${record.workspacePath}\` |`,
    `| 父会话 | \`${record.parentSessionId}\` |`,
    `| 创建时间 | ${record.createdAt} |`,
    ...(record.title ? [`| 任务标题 | ${record.title} |`] : []),
    `| 超时 | ${record.timeoutMs ?? '-'} ms |`,
    ...(record.sessionId ? [`| 目标会话 | \`${record.sessionId}\` |`] : []),
    ...(record.runId ? [`| 运行 ID | \`${record.runId}\` |`] : []),
    '',
    '## 任务原文',
    '',
    record.task,
    '',
    '## 续跑指引',
    '',
    `见 ${record.resumePath}。`,
    '',
  ].join('\n')
  writeFileSync(record.taskPath, markdown)
}

/** Persist the child session identity once the run started (native: real host session id; SDK: parent-side run id). */
export function updateSessionIdentity(record: DelegationRecord | undefined, identity: { sessionId?: string; runId?: string }): void {
  if (!record) return
  if (identity.sessionId !== undefined) record.sessionId = identity.sessionId
  if (identity.runId !== undefined) record.runId = identity.runId
  try {
    writeTaskJson({ ...record })
    writeTaskMarkdown({ ...record })
  } catch { /* best-effort */ }
}

function appendLine(record: DelegationRecord, line: string): void {
  try { appendFileSync(record.progressPath, `[${timestamp()}] ${line.trim()}\n`) } catch { /* best-effort */ }
}

/** Append one checkpoint line (UTC HH:MM:SS). Silent when the record is missing or unwritable. */
export function appendProgress(record: DelegationRecord | undefined, line: string): void {
  if (!record || !line.trim()) return
  appendLine(record, line)
}

/** Bounded tail of the checkpoint file, with a one-line account header. Used by job readOutput for live visibility. */
export function progressSummary(record: DelegationRecord | undefined, maxLines = 16): string {
  if (!record) return ''
  try {
    const lines = readFileSync(record.progressPath, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-maxLines)
    const checkpoints = lines.filter(line => /^- |^\[/.test(line)).length
    return `delegation ${record.delegationId} · ${checkpoints} checkpoints\n${tail.join('\n')}`
  } catch {
    return `delegation ${record.delegationId} (progress file unavailable)`
  }
}

export function summarize(text: string, maxChars = 200): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}…`
}

/** Append the terminal result line and rewrite the resume note with the settled status. */
export function finalizeRecord(record: DelegationRecord | undefined, status: string, summary?: string): void {
  if (!record) return
  appendProgress(record, `[result] ${status}${summary ? ` — ${summarize(summary)}` : ''}`)
  writeResumeNote(record, status)
}

function writeResumeNote(record: DelegationRecord, status: string): void {
  const sample = JSON.stringify({
    name: 'delegate_workspace',
    arguments: {
      target: record.target,
      task: `续跑委派 ${record.delegationId}：任务书 ${record.taskPath}，进度 ${record.progressPath}。先阅读两者，检查现场（git status/diff、生成产物），确定未完成步骤后继续，完成验收标准后报告。`,
      run_in_background: true,
    },
  }, null, 2)
  const session = record.sessionId ?? record.runId
  const note = [
    `# 委派恢复说明 · ${record.delegationId}`,
    '',
    `任务已于 ${new Date().toISOString()} 以 **${status}** 结算。目标会话与现场保留，可按下面步骤继续（重新委派时新会话对上一会话无上下文，只能从本目录与现场恢复）。`,
    '',
    '- 任务书: `' + record.taskPath + '` — 任务原文、目标、父会话、创建时间与超时配置',
    '- 进度: `' + record.progressPath + '` — 每行一个已完成步骤；最后一行 `[result]` 是结算状态',
    '- 现场: `' + record.workspacePath + '` — 用 git status/diff 与生成产物核对完成度',
    ...(session ? [`- 目标会话: \`${session}\` — 宿主保留该会话；crashed/aborted 后若宿主侧仍存活可从工作区列表直接打开继续`] : []),
    '',
    '## 续跑方式',
    '',
    '1. 在宿主界面从目标工作区的会话列表打开保留会话直接继续，原上下文完整；或',
    '2. 在同一工作区新开会话，先读 task.json 与 progress.md，结合现场状态确定未完成步骤，再重新委派（建议 run_in_background: true）。',
    '',
    '## 续跑任务书样例',
    '',
    '```json',
    sample,
    '```',
    '',
  ].join('\n')
  try { writeFileSync(record.resumePath, note) } catch { /* best-effort */ }
}

/**
 * Wrap the raw task in a delegation envelope that teaches the child session
 * the checkpoint protocol. Without a record the task is passed through
 * unchanged so the pre-record behaviour (and any caller that disables
 * records) is preserved exactly.
 */
export function composeTask(task: string, record?: DelegationRecord): string {
  if (!record) return task
  return [
    `[委派任务书 delegationId=${record.delegationId}]`,
    `任务书文件: ${record.taskPath}（任务原文、目标、父会话与创建时间，可读取以确认上下文）`,
    `进度协议: 每完成一个可验证步骤，向 ${record.progressPath} 追加一行 \`- <步骤简述>\`；任务结束时追加 \`- [result] <结果摘要>\`。不要改写已有行。若无法写入该文件，继续执行即可，进度协议失败不中断任务。`,
    '---- 任务原文 ----',
    task,
    '---- 任务结束 ----',
  ].join('\n')
}

/**
 * Derive the default pinned session title from the task itself: the first
 * line, stripped of leading markdown/slash markers and truncated — e.g.
 * `改造 cordis.patch.yml 配置…`. The workspace already owns the session's
 * list placement, so the title stays short and does not repeat the workspace
 * name. Callers that want a `类别/任务` shape (e.g. `绘画/画一只猫`) pass an
 * explicit `title`.
 */
export function deriveDelegationTitle(task: string, maxSummary = 40): string {
  const summary = (task.split('\n')[0] ?? '')
    // Leading markdown bullets, blockquote, headings and list numbers.
    .replace(/^\s*(?:[-*#>]|\d+[.)])\s*/, '')
    // The local path accepts slash-prefixed tasks; never render a leading slash.
    .replace(/^\/+/, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const clipped = summary.length > maxSummary ? `${summary.slice(0, maxSummary)}…` : summary
  return clipped || '委派任务'
}

/**
 * Where the target session's transcript lives.
 * - local: host-owned session; the host retains it and its log in the host
 *   session store (root configured by the host, commonly <DSH_HOME>/sessions).
 * - sdk: the child writes its store under its own DSH_HOME.
 */
export function sessionStoreHint(mode: DelegationMode, dshHome: string): string {
  return mode === 'local'
    ? `host session store under ${dshHome}/sessions (host-configured root; the retained session's transcript sits in the workspace project folder, keyed by session id)`
    : `child session store under ${dshHome}/sessions (SDK run ids are not child session ids; locate by modification time — see README "SDK Store 策略")`
}

/**
 * Structured settlement classification, aligned with the parent-side analysis
 * contract (`timeout | cancelled | crash | host-reclaim | unknown` plus
 * specific refinements; `failed` plays the `unknown` slot). Order matters: a
 * timeout or a caller cancel is attributed to us first; only a genuinely
 * foreign 'aborted' (no local signal involved) is reported as host-reclaim.
 */
export type DelegationStatus =
  | 'completed'
  | 'timeout'
  | 'cancelled'
  | 'crash'
  | 'host-reclaim'
  | 'refused'
  | 'max-tokens'
  | 'failed'

export interface ClassificationInput {
  /** stopReason surfaced by the child run (completed/aborted/error/refusal/max-tokens/…). */
  stopReason?: string
  /** Our internal deadline fired. */
  timeout: boolean
  /** The caller's signal (foreground exec.signal / background job controller) aborted. */
  canceled: boolean
  /** A raw error was thrown instead of a structured stop reason. */
  crashed?: unknown
}

export function classifyDelegation(input: ClassificationInput): DelegationStatus {
  if (input.timeout) return 'timeout'
  if (input.canceled) return 'cancelled'
  if (input.crashed !== undefined) return 'crash'
  switch (input.stopReason) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'refusal': return 'refused'
    case 'aborted': return 'host-reclaim'
    case 'error': return 'crash'
    default: return 'failed'
  }
}

export const STATUS_LABEL: Record<DelegationStatus, string> = {
  completed: 'completed',
  timeout: 'timed out',
  cancelled: 'cancelled by caller',
  crash: 'session crashed',
  'host-reclaim': 'reclaimed/aborted by host (host reclaim, manual stop or unknown host-side cause)',
  refused: 'refused',
  'max-tokens': 'hit max output tokens',
  failed: 'failed (unclassified)',
}

/**
 * Structured settlement metadata attached to every failed/aborted delegation:
 * a classified reason, the target session, where its transcript lives, and the
 * delegation record paths for resume. Equivalent information is packed into the
 * background job's `detail` and the foreground error message (plus
 * `failure.diagnostic` for programmatic consumers).
 */
export interface DelegationDiagnostic {
  status: DelegationStatus
  /** Original error / stop text. */
  detail: string
  /** Host session id (local path only). */
  sessionId?: string
  /** Parent-side run id (SDK path; local path repeats the session id). */
  runId?: string
  elapsedMs: number
  record?: DelegationRecord
  /** Which path the delegation ran on; drives the transcript hint when the record is missing. */
  mode: DelegationMode
  dshHome: string
}