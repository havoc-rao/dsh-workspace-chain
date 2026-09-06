import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { checkDirectory, type ResolvedConfig } from './config.js'

export class DelegationFailure extends Error {
  constructor(readonly stopReason: string, message: string) { super(message) }
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

function deadline(ms: number, signal: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`workspace delegation timed out after ${ms}ms`)), ms)
  timer.unref()
  return { signal: AbortSignal.any([signal, controller.signal]), dispose: () => clearTimeout(timer) }
}

export function createDelegationTool(ctx: Context, config: ResolvedConfig) {
  return defineTool({
    name: config.toolName,
    description: 'Delegate a self-contained task to a fresh agent session in a configured local workspace. Wait for its final output, or return a background job id to collect with job_output and stop with job_kill.',
    parameters: {
      target: { type: 'string', required: true, description: `Target workspace agent name. Configured targets: ${[...config.targets.keys()].join(', ')}.` },
      task: { type: 'string', required: true, description: 'Standalone task including context, files, goals and acceptance criteria. The target is a fresh session with no knowledge of this conversation.' },
      run_in_background: { type: 'boolean', description: 'Return a job id immediately; collect with job_output. Default false: wait for the final output.' },
    },
    output: {
      schema: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'foreground', required: true }, output: { type: 'string', required: true }, runId: { type: 'string', required: true } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'background', required: true }, jobId: { type: 'string', required: true } } },
      ] },
      presentationMeta: (args, value): Record<string, string | boolean> => value.kind === 'foreground' ? { target: args.target, runId: value.runId } : { target: args.target, jobId: value.jobId },
      render: (_args, value) => [{ type: 'text', text: value.kind === 'foreground' ? value.output : `Started workspace delegation job ${value.jobId}` }],
    },
    presentCall: args => ({ card: 'generic', title: `Delegate to ${args.target}`, kind: 'other', rawInput: args.task }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const target = config.targets.get(args.target)
      if (!target) throw new Error(`Unknown workspace target ${JSON.stringify(args.target)}. Available targets: ${[...config.targets.keys()].join(', ')}`)
      if (!args.task.trim()) throw new Error('task must not be empty')
      // Recheck canonical path: reject deletion or replacement with a symlink elsewhere.
      if (checkDirectory(target.cwd) !== target.cwd) throw new Error(`Workspace directory changed: ${target.cwd}`)
      const parent = exec.agent
      if (!parent) throw new Error('workspace delegation requires a calling agent')
      exec.signal.throwIfAborted()
      const request = { parent, label: `Workspace: ${args.target}`, prompt: [{ type: 'text' as const, text: args.task }] }
      if (args.run_in_background) {
        const jobs = ctx.get('jobs')
        if (!jobs) throw new Error('Background jobs unavailable: load dsh-jobs-local and dsh-tool-jobs')
        const jobId = jobs.start({
          kind: 'subagent', label: request.label, owner: parent,
          run: () => {
            const controller = new AbortController()
            const timeout = deadline(config.defaultTimeoutMs, controller.signal)
            const done = (async (): Promise<JobOutcome> => {
              let published = false
              try {
                const run = await ctx.subagents.start(target.providerName, { ...request, signal: timeout.signal })
                published = true
                const output = await collectRun(run)
                return { status: 'completed', output }
              } catch (error) {
                const killed = controller.signal.aborted && !(error instanceof AggregateError)
                  && (!published || error instanceof DelegationFailure && error.stopReason === 'aborted')
                return { status: killed ? 'killed' : 'failed', detail: String(error) }
              } finally { timeout.dispose() }
            })()
            return { done, cancel: (reason?: string) => controller.abort(reason ?? 'workspace job killed') }
          },
        })
        return { kind: 'background' as const, jobId }
      }
      const timeout = deadline(config.defaultTimeoutMs, exec.signal)
      try {
        const run = await ctx.subagents.start(target.providerName, { ...request, signal: timeout.signal })
        const output = await collectRun(run)
        return { kind: 'foreground' as const, output, runId: run.id }
      } finally { timeout.dispose() }
    },
  })
}
