import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { foldConsumedWork, type Agent } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput, type SubagentRun, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { SessionController, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { sessionEvents } from './session-events.js'
import { checkDirectory } from './config.js'

const depths = new WeakMap<Agent, number>()

export interface NativeRunHooks {
  /** One checkpoint line per lifecycle milestone; the caller appends it to the delegation progress file. */
  progress?: (line: string) => void
  /** Pinned session title (`项目/任务摘要`); pinned via sessionController.rename right after create. */
  title?: string
  /** Preallocated host session id; `sessionController.create` adopts it (`session-<uuid>`). */
  sessionId?: SessionId
}

/**
 * Plan a host session identity up front so the parent holds the id BEFORE the
 * session exists: it is written into the delegation record at call time and
 * returned with the background job response, and `sessionController.create`
 * adopts it (the host contract: an explicit id + the same workspace returns
 * the same session).
 */
export function planSessionId(): SessionId {
  return SessionId(`session-${randomUUID()}`)
}

/**
 * The plugin-facing Host Session API: the `sessionController` service the host
 * mounts (@deepseek-ai/dsh-api-session-controller, Session Remote over Typert).
 * It replaced the retired `ctx.apiProxy` gateway package.
 */
function sessionController(ctx: Context): SessionController {
  const controller = ctx.get('sessionController')
  if (!controller) throw new Error('DSH local session API is unavailable')
  return controller
}

/**
 * Ordinary, host-owned sessions: reuse the same admission and composition API as the UI.
 * With `hooks.sessionId` the caller has preallocated the identity (record + early
 * visibility); without one the host assigns it.
 */
export async function startNativeRun(ctx: Context, workspace: Workspace, parent: Agent, task: string, signal: AbortSignal, hooks?: NativeRunHooks): Promise<SubagentRun> {
  const progress = hooks?.progress
  const api = sessionController(ctx)
  if ((depths.get(parent) ?? 0) >= 4) throw new Error('Workspace delegation depth limit reached')
  signal.throwIfAborted()
  // Preset inheritance: the parent's live session header names the agent preset
  // it was composed from (durable, same source the UI list summaries use), so a
  // delegation child inherits the parent session's composition.
  const preset = parent.session.header.agentPreset
  if (ctx.get('workspaceRegistry')?.get(workspace.id) !== workspace || checkDirectory(workspace.path) !== workspace.path) {
    throw new Error('Target workspace changed before session creation')
  }
  const { sessionId } = await api.create({
    workspaceId: workspace.id,
    ...preset !== undefined ? { agentPreset: preset } : {},
    ...hooks?.sessionId !== undefined ? { sessionId: hooks.sessionId } : {},
  })
  progress?.(`session created ${sessionId}`)
  // Pin a descriptive title (`项目/任务摘要`) so the workspace session list
  // shows the concrete task instead of a generic auto-generated one. rename
  // pins the title against automatic regeneration; best-effort — an absent
  // rename on an older host (or a rejection) only logs a progress line.
  if (hooks?.title) {
    try {
      await api.rename({ sessionId, title: hooks.title })
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
 * session keeps its full context, composition and pinned title:
 * `sessionController.create` with the existing id resumes/adopts it (no preset
 * is named, so the session keeps the one it recorded), and the new task is
 * delivered into it with a regular prompt. No new session is created. While the
 * session is still running the prompt queues behind its current turn.
 */
export async function continueNativeRun(ctx: Context, workspace: Workspace, parent: Agent, sessionId: string, task: string, signal: AbortSignal, hooks?: NativeRunHooks): Promise<SubagentRun> {
  const id = SessionId(sessionId)
  const progress = hooks?.progress
  const api = sessionController(ctx)
  if ((depths.get(parent) ?? 0) >= 4) throw new Error('Workspace delegation depth limit reached')
  signal.throwIfAborted()
  if (ctx.get('workspaceRegistry')?.get(workspace.id) !== workspace || checkDirectory(workspace.path) !== workspace.path) {
    throw new Error('Target workspace changed before session continuation')
  }
  // Verify the session exists and belongs to this workspace before adopting it:
  // a wrong id must fail with a readable cause, not adopt an unrelated session.
  const listing = await api.list({}, signal)
  const listed = listing.items.find(item => item.sessionId === id)
  if (!listed) {
    throw new Error(`DSH session ${id} was not found; use the sessionId a previous delegation returned (persisted in its delegation record)`)
  }
  if (listed.cwd !== undefined && listed.cwd !== workspace.path) {
    throw new Error(`DSH session ${id} belongs to ${listed.cwd}, not the target workspace ${workspace.path}`)
  }
  progress?.(`continuing session ${id}${listed.running ? ' (still running; the new task queues behind its current turn)' : ''}`)
  const adopted = await api.create({ sessionId: id, workspaceId: workspace.id })
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

/** Deliver the task into an adopted session, wait for quiescence and fold the turn result. */
function driveSession(api: SessionController, child: Agent, sessionId: SessionId, task: string, signal: AbortSignal, progress?: (line: string) => void): Promise<SubagentResult> {
  const events = () => sessionEvents(child.session)
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    progress?.('cancel requested')
    cancellation ??= Promise.resolve(api.cancel({ sessionId })).then(() => {})
    // Observe immediately; propagate any cancellation failure through result below.
    void cancellation.catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  return (async () => {
    try {
      signal.throwIfAborted()
      // A fresh identity per delivery; the host persists it on the accepted user message.
      const requestId = randomUUID() as SessionRequestId
      // Two text parts keep a slash-prefixed task from being interpreted as a UI command.
      await api.prompt({ sessionId, mode: 'queue', requestId, content: [
        { type: 'text', text: '请在当前工作区执行以下委派任务，完成后报告结果：\n' },
        { type: 'text', text: task },
      ] }, signal)
      progress?.('task delivered to the target session')
      // Abort can race durable prompt admission; cancel again after it completes.
      if (signal.aborted) await api.cancel({ sessionId })
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