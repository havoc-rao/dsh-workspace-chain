import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { startNativeRun } from './native.js'
import { checkDirectory, type ResolvedConfig } from './config.js'
import { adaptiveDeadline, probeActivity } from './patience.js'
import {
  appendProgress, classifyDelegation, composeTask, deriveDelegationTitle, finalizeRecord, newDelegationId,
  progressSummary, sessionStoreHint, updateSessionIdentity, writeDelegationRecord, STATUS_LABEL,
  type DelegationDiagnostic, type DelegationRecord, type DelegationStatus, type DelegationMode,
} from './delegation-record.js'

export { classifyDelegation, composeTask, type DelegationDiagnostic, type DelegationRecord, type DelegationStatus } from './delegation-record.js'

export class DelegationFailure extends Error {
  constructor(readonly stopReason: string, message: string, diagnostic?: DelegationDiagnostic) { super(message); this.diagnostic = diagnostic }
  diagnostic?: DelegationDiagnostic
}

export async function collectRun(run: SubagentRun): Promise<string> {
  let output = ''
  let failed = false
  let failure: unknown
  try {
    const result = await run.result
    output = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
    if (result.stopReason !== 'completed') throw new DelegationFailure(result.stopReason,
      `workspace delegation ended: ${result.stopReason}`
      + (result.diagnostic ? `\nDiagnostic: ${result.diagnostic}` : '')
      + (output ? `\nPartial output:\n${output}` : ''),
    )
  } catch (error) { failed = true; failure = error }
  try { await run.dispose() } catch (error) {
    if (failed) throw new AggregateError([failure, error], `${String(failure)}; dispose failed: ${String(error)}`)
    throw error
  }
  if (failed) throw failure
  return output
}

/**
 * Activity-aware deadline for a delegation run: the base window is
 * `timeoutMs`, and every round while the target still shows activity extends
 * the wait by `timeoutExtensionMs` (up to `maxTimeoutExtensions` rounds).
 * Timeout is declared only after a full extension window of silence.
 */
function patienceFor(config: ResolvedConfig, record: DelegationRecord | undefined, dshHome: string, signal: AbortSignal, timeoutMs: number, run: () => SubagentRun | undefined) {
  return adaptiveDeadline({
    baseMs: timeoutMs,
    extensionMs: config.timeoutExtensionMs,
    maxExtensions: config.maxTimeoutExtensions,
    signal,
    probe: () => probeActivity({ record, run, dshHome, freshMs: config.timeoutExtensionMs }),
    onExtend: (extension, probe) => appendProgress(record,
      `[extend] target still active (${probe.detail}); wait extended ${extension}/${config.maxTimeoutExtensions} (+${config.timeoutExtensionMs}ms)`),
  })
}

function checkedTimeout(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) throw new TypeError('timeout_ms must be a positive integer <= 2147483647')
  return ms
}

function logWarn(ctx: Context, message: string): void {
  ;(ctx.logger?.warn ?? ((text: string) => console.warn(`[workspace-chain] ${text}`)))(message)
}

interface RunState {
  mode: DelegationMode
  record?: DelegationRecord
  startedAt: number
  dshHome: string
  timeoutExpired: () => boolean
  /** Why the activity-aware deadline expired (missing unless a terminal timeout hit). */
  timeoutReason?: () => string | undefined
  canceled: () => boolean
}

/** Best-effort record creation: an unwritable workspace degrades to the pre-record behaviour, not to a failed delegation. */
function createRecord(ctx: Context, config: ResolvedConfig, input: { mode: DelegationMode; target: string; workspacePath: string; parentSessionId: string; task: string; title?: string; timeoutMs: number }): DelegationRecord | undefined {
  if (!config.delegationRecords) return undefined
  try {
    return writeDelegationRecord({
      delegationId: newDelegationId(), createdAt: new Date().toISOString(),
      mode: input.mode, target: input.target, workspacePath: input.workspacePath,
      parentSessionId: input.parentSessionId, task: input.task, ...input.title !== undefined ? { title: input.title } : {}, timeoutMs: input.timeoutMs,
    })
  } catch (error) {
    logWarn(ctx, `delegation record unavailable (continuing without checkpoints): ${String(error)}`)
    return undefined
  }
}

function diagnose(state: RunState, error: unknown, sessionId?: string, runId?: string): DelegationDiagnostic {
  const stopReason = error instanceof DelegationFailure ? error.stopReason : undefined
  const crashed = !(error instanceof DelegationFailure) && !(error instanceof AggregateError) ? error : undefined
  const status = classifyDelegation({ stopReason, timeout: state.timeoutExpired(), canceled: state.canceled(), crashed })
  const timeoutReason = status === 'timeout' ? state.timeoutReason?.() : undefined
  return {
    status,
    detail: timeoutReason ? `${String(error)}\n${timeoutReason}` : String(error),
    ...sessionId !== undefined ? { sessionId } : {},
    ...runId !== undefined ? { runId } : {},
    elapsedMs: Date.now() - state.startedAt,
    record: state.record,
    mode: state.mode,
    dshHome: state.dshHome,
  }
}

function formatDiagnostic(diag: DelegationDiagnostic): string {
  const record = diag.record
  const lines = [
    `workspace delegation ${diag.status === 'completed' ? 'completed' : 'failed'}: ${STATUS_LABEL[diag.status]} (elapsed ${diag.elapsedMs}ms)`,
    `Diagnostic: ${diag.detail}`,
    `Classification: ${diag.status}`,
  ]
  if (diag.sessionId) lines.push(`Target session: ${diag.sessionId} (host-retained; open it from the target workspace's session list in the DSH UI, or continue via the resume note)`)
  else if (diag.runId) lines.push(`SDK run id: ${diag.runId} (parent-side; the child session id differs — see README "SDK Store 策略")`)
  lines.push(`Transcript: ${sessionStoreHint(diag.mode, diag.dshHome)}`)
  if (record) {
    lines.push(`Checkpoint: ${record.progressPath}`, `Task record: ${record.taskPath}`, `Resume: ${record.resumePath} — recovery instructions and a ready-made resume task book sample`)
    const summary = progressSummary(record)
    if (summary) lines.push(...summary.split('\n').map(line => `  ${line}`))
  } else {
    lines.push('Checkpoint: unavailable (delegation records disabled or the target workspace is not writable)')
  }
  return lines.join('\n')
}

/** Attach a structured diagnosis to the thrown error so callers can branch on `error.diagnostic.status`. */
function enrich(error: unknown, diag: DelegationDiagnostic): DelegationFailure {
  if (error instanceof DelegationFailure) {
    error.diagnostic = diag
    error.message = formatDiagnostic(diag)
    return error
  }
  return new DelegationFailure(diag.status, formatDiagnostic(diag), diag)
}

export function createDelegationTool(ctx: Context, config: ResolvedConfig) {
  return defineTool({
    name: config.toolName,
    description: 'Delegate a self-contained task to a fresh agent session in a registered local workspace. Wait for its final output, or return a background job id to collect with job_output and stop with job_kill.\nParallel scheduling: launch work that is independent of your current steps in the background — e.g. you only need a contract the other side returns (a key name, an API shape) and can keep working on adjacent steps meanwhile — with run_in_background: true, continue your own work, then collect with job_output (wait: true to block) before claiming completion. Use the foreground wait only when the next step cannot proceed without this result.\nTimeouts are activity-aware, not hard caps: while the target keeps producing (a live local agent, session-store writes, or progress checkpoints) the wait extends in timeoutExtensionMs rounds up to maxTimeoutExtensions; a timeout is declared only after the target has been silent for a full extension window. An interrupted foreground call cancels the child session (the host retains it — the failure report points to the delegation record and resume instructions). Every delegation writes a task book and progress checkpoints under <workspace>/.dsh/delegations/<delegationId>/',
    parameters: {
      target: { type: 'string', required: true, description: `Registered workspace absolute path, or an explicit SDK target name. Configured SDK targets: ${[...config.targets.keys()].join(', ')}.` },
      task: { type: 'string', required: true, description: 'Standalone task including context, files, goals and acceptance criteria. The target is a fresh session with no knowledge of this conversation.' },
      run_in_background: { type: 'boolean', description: 'Return a job id immediately; collect with job_output (wait: true to block up to the host wait cap) and cancel with job_kill. Default false: wait for the final output. Prefer true for tasks that can run in parallel with your remaining work; the foreground wait blocks until settlement or timeout.' },
      timeout_ms: { type: 'number', description: 'Override the configured defaultTimeoutMs for this call (positive integer ms). The target is cancelled only after the activity check: while it keeps producing, the wait extends by timeoutExtensionMs per round (maxTimeoutExtensions rounds); timeout is declared after a full silent extension window. On timeout / cancellation the delegation record explains how to resume, and the session stays open in the host.' },
      title: { type: 'string', description: 'Optional pinned title for the created session (local path only, requires host sessions.rename). Defaults to `<project>/<task summary>`, e.g. `dsh-remote/改造 cordis 配置`, so the workspace session list shows the concrete task.' },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'foreground', required: true }, output: { type: 'string', required: true }, sessionId: { type: 'string' }, runId: { type: 'string', required: true }, delegationId: { type: 'string' }, checkpointPath: { type: 'string' } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'background', required: true }, jobId: { type: 'string', required: true }, delegationId: { type: 'string' }, checkpointPath: { type: 'string' } } },
      ] },
      presentationMeta: (args, value): Record<string, string | boolean> => {
        const meta: Record<string, string | boolean> = { target: args.target }
        if (value.kind === 'foreground') {
          meta.runId = value.runId
          if (value.sessionId) meta.sessionId = value.sessionId
        } else {
          meta.jobId = value.jobId
        }
        if (value.delegationId) meta.delegationId = value.delegationId
        if (value.checkpointPath) meta.checkpointPath = value.checkpointPath
        return meta
      },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'foreground' ? value.output : `Started workspace delegation job ${value.jobId}${value.delegationId ? ` (${value.delegationId})` : ''}` }],
    },
    presentCall: args => ({ card: 'generic', title: `Delegate to ${args.target}`, kind: 'other', rawInput: args.task }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = config.targets.get(args.target)
      const workspace = !target ? ctx.get('workspaceRegistry')?.list().find(w => w.path === args.target) : undefined
      if (!target && !workspace) throw new Error(`Unknown workspace target ${JSON.stringify(args.target)}. Available targets: ${[...config.targets.keys()].join(', ')}`)
      if (!args.task.trim()) throw new Error('task must not be empty')
      // Recheck canonical path: reject deletion or replacement with a symlink elsewhere.
      if (target && checkDirectory(target.cwd) !== target.cwd) throw new Error(`Workspace directory changed: ${target.cwd}`)
      const parent = exec.agent
      if (!parent) throw new Error('workspace delegation requires a calling agent')
      exec.signal.throwIfAborted()
      const timeoutMs = checkedTimeout(args.timeout_ms, config.defaultTimeoutMs)
      const mode: DelegationMode = target ? 'sdk' : 'local'
      const workspacePath = target ? target.cwd : workspace!.path
      const dshHome = resolveDshHome(target?.env.DSH_HOME)
      // Pinned session title: the task's own first line (the workspace already
      // owns the session's list placement); an explicit `类别/任务` title wins.
      const title = args.title?.trim() || deriveDelegationTitle(args.task)
      const record = createRecord(ctx, config, { mode, target: args.target, workspacePath, parentSessionId: parent.id, task: args.task, title, timeoutMs })
      const request = { parent, label: `Workspace: ${args.target}`, prompt: [{ type: 'text' as const, text: composeTask(args.task, record) }] }
      const start = (signal: AbortSignal) => target
        ? ctx.subagents.start(target.providerName, { ...request, signal })
        : startNativeRun(ctx, workspace!, parent, request.prompt[0]!.text, signal, { progress: line => appendProgress(record, `[start] ${line}`), ...config.pinnedTitles ? { title } : {} })
      const identity = (run: SubagentRun) => {
        updateSessionIdentity(record, { ...mode === 'local' ? { sessionId: run.id } : {}, runId: run.id })
        if (mode === 'sdk') appendProgress(record, `[start] subagent created ${run.id} (SDK run id)`)
      }
      if (args.run_in_background) {
        const jobs = ctx.get('jobs')
        if (!jobs) throw new Error('Background jobs unavailable: load dsh-jobs-local and dsh-tool-jobs')
        const jobId = jobs.start({
          kind: 'subagent', label: request.label, owner: parent,
          run: () => {
            const controller = new AbortController()
            let run: SubagentRun | undefined
            const timeout = patienceFor(config, record, dshHome, controller.signal, timeoutMs, () => run)
            // startedAt is stamped once, up front, so elapsed reflects the full wait.
            const state: RunState = { mode, record, startedAt: Date.now(), dshHome, timeoutExpired: timeout.expired, timeoutReason: timeout.reason, canceled: () => controller.signal.aborted }
            let terminal: { output?: string } | undefined
            // Live visibility: job_output reads this while the job runs (and
            // the final output after it settles), so a running delegation
            // never looks empty.
            const readOutput = () => terminal?.output ?? progressSummary(record)
            const done = (async (): Promise<JobOutcome> => {
              let published = false
              try {
                run = await start(timeout.signal)
                published = true
                identity(run)
                const output = await collectRun(run)
                finalizeRecord(record, 'completed', output)
                terminal = { output }
                return { status: 'completed', output }
              } catch (error) {
                const runId = run?.id
                const diag = diagnose(state, error, mode === 'local' ? runId : undefined, runId)
                terminal = {}
                finalizeRecord(record, diag.status)
                const killed = controller.signal.aborted && !(error instanceof AggregateError)
                  && (!published || error instanceof DelegationFailure && error.stopReason === 'aborted')
                return { status: killed ? 'killed' : 'failed', detail: killed
                  ? `workspace delegation canceled${typeof controller.signal.reason === 'string' ? `: ${controller.signal.reason}` : ''}\n${formatDiagnostic(diag)}`
                  : formatDiagnostic(diag) }
              } finally { timeout.dispose() }
            })()
            return { done, readOutput, cancel: (reason?: string) => controller.abort(reason ?? 'workspace job killed') }
          },
        })
        return { kind: 'background' as const, jobId, ...record ? { delegationId: record.delegationId, checkpointPath: record.progressPath } : {} }
      }
      let run: SubagentRun | undefined
      const timeout = patienceFor(config, record, dshHome, exec.signal, timeoutMs, () => run)
      const state: RunState = { mode, record, startedAt: Date.now(), dshHome, timeoutExpired: timeout.expired, timeoutReason: timeout.reason, canceled: () => exec.signal.aborted }
      try {
        run = await start(timeout.signal)
        identity(run)
        const output = await collectRun(run)
        finalizeRecord(record, 'completed', output)
        return { kind: 'foreground' as const, output, runId: run.id, ...workspace ? { sessionId: run.id } : {}, ...record ? { delegationId: record.delegationId, checkpointPath: record.progressPath } : {} }
      } catch (error) {
        const runId = run?.id
        const diag = diagnose(state, error, mode === 'local' ? runId : undefined, runId)
        finalizeRecord(record, diag.status)
        throw enrich(error, diag)
      } finally { timeout.dispose() }
    },
  })
}