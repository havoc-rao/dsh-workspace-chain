import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput, type SubagentRun, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { RpcId, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
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
  /** Preallocated host session id; `sessions.create` adopts it (`session-<uuid>`). */
  sessionId?: SessionId
}

/**
 * Plan a host session identity up front so the parent holds the id BEFORE the
 * session exists: it is written into the delegation record at call time and
 * returned with the background job response, and `sessions.create` adopts it
 * (the host contract: an explicit id + the same workspace returns the same
 * session). A host that rejects the fields falls back to a host-generated id.
 */
export function planSessionId(): SessionId {
  return SessionId(`session-${randomUUID()}`)
}

/**
 * Ordinary, host-owned sessions: reuse the same admission and composition API as the UI.
 * With `hooks.sessionId` the caller has preallocated the identity (record + early
 * visibility); without one the host assigns it.
 */
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
  const { sessionId } = await createSession(api, {
    workspaceId: workspace.id,
    ...preset ? { agentPreset: preset } : {},
    ...hooks?.sessionId !== undefined ? { sessionId: hooks.sessionId } : {},
  }, progress, 'session created')
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
  const result = driveSession(api, child, sessionId, task, signal, progress)
  return { id: sessionId, localAgent: child, result,
    // The host owns this session. Keep its log, workspace membership and live continuation.
    async dispose() { await result },
  }
}

/**
 * Return to an existing host session — the one a previous delegation published
 * (its result `sessionId`, or the id persisted in its record). The retained
 * session keeps its full context, composition and pinned title: `sessions.create`
 * with the existing id resumes/adopts it (no preset is named, so the session
 * keeps the one it recorded), and the new task is delivered into it with a
 * regular prompt. No new session is created. While the session is still running
 * the prompt queues behind its current turn.
 */
export async function continueNativeRun(ctx: Context, workspace: Workspace, parent: Agent, sessionId: string, task: string, signal: AbortSignal, hooks?: NativeRunHooks): Promise<SubagentRun> {
  const id = SessionId(sessionId)
  const progress = hooks?.progress
  const api = ctx.get('apiProxy')
  if (!api) throw new Error('DSH local session API is unavailable')
  if ((depths.get(parent) ?? 0) >= 4) throw new Error('Workspace delegation depth limit reached')
  signal.throwIfAborted()
  if (ctx.get('workspaceRegistry')?.get(workspace.id) !== workspace || checkDirectory(workspace.path) !== workspace.path) {
    throw new Error('Target workspace changed before session continuation')
  }
  // Verify the session exists and belongs to this workspace before adopting it:
  // a wrong id must fail with a readable cause, not adopt an unrelated session.
  const listing = value(await api.sessions.list(request({})))
  const listed = listing.items.find(item => item.sessionId === id)
  if (!listed) {
    throw new Error(`DSH session ${id} was not found; use the sessionId a previous delegation returned (persisted in its delegation record)`)
  }
  if (listed.cwd !== undefined && listed.cwd !== workspace.path) {
    throw new Error(`DSH session ${id} belongs to ${listed.cwd}, not the target workspace ${workspace.path}`)
  }
  progress?.(`continuing session ${id}${listed.running ? ' (still running; the new task queues behind its current turn)' : ''}`)
  const adopted = value(await api.sessions.create(request({ sessionId: id, workspaceId: workspace.id })))
  progress?.('session resumed')
  if (adopted.sessionId !== id) throw new Error(`DSH resumed a different session than requested: ${adopted.sessionId}`)
  const child = ctx.agents.get(id)
  if (!child) throw new Error(`DSH session ${id} was not resumed into a live agent`)
  depths.set(child, (depths.get(parent) ?? 0) + 1)
  const result = driveSession(api, child, id, task, signal, progress)
  return { id, localAgent: child, result,
    // Same retention contract as a fresh session: the host owns it.
    async dispose() { await result },
  }
}

/** Adopt the preallocated identity, falling back to a host-generated id on rejection. */
async function createSession(api: { sessions: { create: (request: { rpcId: RpcId; payload: { workspaceId: Workspace['id']; agentPreset?: string; sessionId?: SessionId } }) => Promise<RpcResponse<{ sessionId: SessionId; agentPreset?: string }>> } }, payload: { workspaceId: Workspace['id']; agentPreset?: string; sessionId?: SessionId }, progress?: (line: string) => void, done?: string): Promise<{ sessionId: SessionId }> {
  try {
    const created = value(await api.sessions.create(request(payload)))
    progress?.(`${done ?? 'session created'} ${created.sessionId}`)
    return created
  } catch (error) {
    if (payload.sessionId === undefined) throw error
    // Older host without session-id preallocation: retry with a host-generated id.
    progress?.(`session preallocation unavailable (${String(error).split('\n')[0]}); host assigns the session id`)
    const created = value(await api.sessions.create(request({ workspaceId: payload.workspaceId, ...payload.agentPreset !== undefined ? { agentPreset: payload.agentPreset } : {} })))
    progress?.(`${done ?? 'session created'} ${created.sessionId}`)
    return created
  }
}

/** Deliver the task into an adopted session, wait for quiescence and fold the turn result. */
function driveSession(api: { sessions: { prompt: (request: { rpcId: RpcId; payload: { sessionId: SessionId; mode: 'queue'; content: { type: 'text'; text: string }[] } }) => Promise<RpcResponse<{ accepted: true; command?: { kind: 'success'; text?: string } }>>; cancel: (request: { rpcId: RpcId; payload: { sessionId: SessionId } }) => Promise<RpcResponse<{ accepted: true }>> } }, child: Agent, sessionId: SessionId, task: string, signal: AbortSignal, progress?: (line: string) => void): Promise<SubagentResult> {
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
  return (async () => {
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
}