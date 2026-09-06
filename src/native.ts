import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput, type SubagentRun, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { RpcId, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { sessionEvents } from './session-events.js'
import { checkDirectory } from './config.js'

const depths = new WeakMap<Agent, number>()
const request = <T>(payload: T) => ({ rpcId: randomUUID() as RpcId, payload })
function value<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

export interface NativeRunHooks {
  /** One checkpoint line per lifecycle milestone; the caller appends it to the delegation progress file. */
  progress?: (line: string) => void
  /** Pinned session title (`项目/任务摘要`); pinned via sessions.rename right after create. */
  title?: string
}

/** Ordinary, host-owned sessions: reuse the same admission and composition API as the UI. */
export async function startNativeRun(ctx: Context, workspace: Workspace, parent: Agent, task: string, signal: AbortSignal, hooks?: NativeRunHooks): Promise<SubagentRun> {
  const progress = hooks?.progress
  const api = ctx.get('apiProxy')
  if (!api) throw new Error('DSH local session API is unavailable')
  if ((depths.get(parent) ?? 0) >= 4) throw new Error('Workspace delegation depth limit reached')
  signal.throwIfAborted()
  // Resolve the effective preset through the API: the header can precede a preset switch.
  const listing = value(await api.sessions.list(request({})))
  const preset = listing.items.find(item => item.sessionId === parent.id)?.agentPreset
  signal.throwIfAborted()
  if (ctx.get('workspaceRegistry')?.get(workspace.id) !== workspace || checkDirectory(workspace.path) !== workspace.path) {
    throw new Error('Target workspace changed before session creation')
  }
  const { sessionId } = value(await api.sessions.create(request({ workspaceId: workspace.id, ...preset ? { agentPreset: preset } : {} })))
  progress?.(`session created ${sessionId}`)
  // Pin a descriptive title (`项目/任务摘要`) so the workspace session list
  // shows the concrete task instead of a generic auto-generated one. rename
  // pins the title against automatic regeneration; best-effort — an absent
  // rename on an older host (or a rejection) only logs a progress line.
  if (hooks?.title && typeof api.sessions.rename === 'function') {
    try {
      value(await api.sessions.rename(request({ sessionId, title: hooks.title })))
      progress?.('title pinned')
    } catch (error) {
      progress?.(`title not pinned: ${String(error)}`)
    }
  }
  const child = ctx.agents.get(sessionId)
  if (!child) throw new Error(`DSH created session ${sessionId} without a live agent`)
  depths.set(child, (depths.get(parent) ?? 0) + 1)
  const events = () => sessionEvents(child.session)
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    progress?.('cancel requested')
    cancellation ??= api.sessions.cancel(request({ sessionId })).then(response => { value(response) })
    // Observe immediately; propagate any cancellation failure through result below.
    void cancellation.catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const result: Promise<SubagentResult> = (async () => {
    try {
      signal.throwIfAborted()
      // Two text parts keep a slash-prefixed task from being interpreted as a UI command.
      value(await api.sessions.prompt(request({ sessionId, mode: 'queue', content: [
        { type: 'text', text: '请在当前工作区执行以下委派任务，完成后报告结果：\n' },
        { type: 'text', text: task },
      ] })))
      progress?.('task delivered to the target session')
      // Abort can race durable prompt admission; cancel again after it completes.
      if (signal.aborted) value(await api.sessions.cancel(request({ sessionId })))
      await child.whenIdle()
      if (cancellation) await cancellation
      const completedEvents = events()
      const reason = foldConsumedWork(completedEvents).end?.data.reason
      return {
        output: finalAssistantOutput(completedEvents) ?? [],
        stopReason: signal.aborted ? 'aborted' : reason?.kind === 'completed' ? 'completed'
          : reason?.kind === 'max-tokens' ? 'max-tokens' : reason?.kind === 'aborted' ? 'aborted'
          : reason?.kind === 'blocked' ? 'refusal' : 'error',
        diagnostic: `DSH session: ${sessionId}${reason?.kind === 'error' ? `; ${reason.error.message}` : ''}`,
      }
    } catch (error) {
      if (cancellation) await cancellation
      if (signal.aborted) await child.whenIdle()
      return { output: finalAssistantOutput(events()) ?? [], stopReason: signal.aborted ? 'aborted' : 'error', diagnostic: `DSH session: ${sessionId}; ${String(error)}` }
    } finally { signal.removeEventListener('abort', cancel) }
  })()
  return {
    id: sessionId, localAgent: child, result,
    // The host owns this session. Keep its log, workspace membership and live continuation.
    async dispose() { await result },
  }
}
