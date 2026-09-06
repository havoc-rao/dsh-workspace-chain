import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { continueNativeRun, planSessionId, startNativeRun } from '../src/native.js'
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'native-lifecycle-'))); roots.push(path)
  const workspace = { id: 'workspace', path } as Workspace
  const parent = { id: 'parent' } as Agent
  const child = { session: { events: [] }, whenIdle: vi.fn(async () => {}) }
  const ok = (value: unknown) => ({ rpcId: 'fixture', result: { ok: true, value } })
  const listed: { sessionId: string; agentPreset?: string; cwd?: string; running?: boolean }[] = [
    { sessionId: 'parent', agentPreset: 'standard' },
  ]
  const sessions = {
    list: vi.fn(async () => ok({ items: listed })),
    create: vi.fn(async (r: { payload: { sessionId?: string } }) => ok({ sessionId: r.payload.sessionId ?? 'child' })),
    rename: vi.fn(async () => ok({ title: 'pinned', seq: 1 })),
    prompt: vi.fn(async () => ok({ accepted: true })),
    cancel: vi.fn(async () => ok({ accepted: true })),
  }
  const ctx = { get: (name: string) => name === 'apiProxy' ? { sessions } : { get: () => workspace }, agents: { get: () => child } } as unknown as Context
  return { ctx, workspace, parent, child, sessions, listed }
}
it('passes the effective preset and workspace identity to create; a failed prompt is not success', async () => {
  const f = fixture()
  f.sessions.prompt.mockResolvedValue({ rpcId: 'fixture', result: { ok: false, error: { code: 'model-unavailable', message: 'no model' } } } as never)
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'hello', new AbortController().signal)
  expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payload: { workspaceId: 'workspace', agentPreset: 'standard' } }))
  expect(await run.result).toMatchObject({ stopReason: 'error', diagnostic: expect.stringContaining('no model') })
  await run.dispose()
})
it('does not create a session after cancellation or continue after create rejection', async () => {
  const f = fixture()
  await expect(startNativeRun(f.ctx, f.workspace, f.parent, 'hello', AbortSignal.abort())).rejects.toThrow()
  expect(f.sessions.create).not.toHaveBeenCalled()
  f.sessions.create.mockResolvedValue({ rpcId: 'fixture', result: { ok: false, error: { code: 'workspace-attach-failed', message: 'attach failed' } } } as never)
  await expect(startNativeRun(f.ctx, f.workspace, f.parent, 'hello', new AbortController().signal)).rejects.toThrow('attach failed')
  expect(f.sessions.prompt).not.toHaveBeenCalled()
})
it('cancels again when abort races prompt admission, waits for idle and keeps the host session', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.sessions.prompt.mockImplementation(async () => {
    controller.abort()
    return { rpcId: 'fixture', result: { ok: true, value: { accepted: true } } }
  })
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'hello', controller.signal)
  expect(await run.result).toMatchObject({ stopReason: 'aborted' })
  expect(f.sessions.cancel).toHaveBeenCalledTimes(2)
  expect(f.child.whenIdle).toHaveBeenCalled()
  await run.dispose()
  expect(f.sessions.cancel).toHaveBeenCalledTimes(2)
})
it('pins the derived title right after create and reports it through progress', async () => {
  const f = fixture()
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'Draw a chart', new AbortController().signal, { title: '绘画/绘制图表', progress: line => lines.push(line) })
  expect(f.sessions.rename).toHaveBeenCalledTimes(1)
  expect(f.sessions.rename).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: 'child', title: '绘画/绘制图表' } }))
  expect(lines.filter(line => line.includes('title pinned'))).toHaveLength(1)
  expect(f.sessions.prompt).toHaveBeenCalledOnce()
  await run.dispose()
})
it('keeps delegating when title pinning fails and skips rename without a title', async () => {
  const f = fixture()
  f.sessions.rename.mockResolvedValue({ rpcId: 'fixture', result: { ok: false, error: { code: 'title-invalid', message: 'empty' } } } as never)
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { title: '项目/任务', progress: line => lines.push(line) })
  expect(lines.some(line => line.includes('title not pinned'))).toBe(true)
  expect(f.sessions.prompt).toHaveBeenCalledOnce()
  await run.dispose()
  const withoutTitle = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal)
  expect(f.sessions.rename).toHaveBeenCalledTimes(1)
  await withoutTitle.dispose()
})
it('adopts a preallocated session id on create and records it in progress', async () => {
  const f = fixture()
  const planned = planSessionId()
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { sessionId: planned, progress: line => lines.push(line) })
  expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sessionId: planned, workspaceId: 'workspace', agentPreset: 'standard' }) }))
  expect(lines).toContain(`session created ${planned}`)
  expect(run.id).toBe(planned)
  await run.dispose()
})
it('falls back to a host-generated id when the host rejects the preallocated id', async () => {
  const f = fixture()
  f.sessions.create
    .mockResolvedValueOnce({ rpcId: 'fixture', result: { ok: false, error: { code: 'internal', message: 'unknown field sessionId' } } } as never)
    .mockResolvedValueOnce({ rpcId: 'fixture', result: { ok: true, value: { sessionId: 'session-host-assigned' } } } as never)
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { sessionId: planSessionId(), progress: line => lines.push(line) })
  expect(f.sessions.create).toHaveBeenCalledTimes(2)
  expect(f.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { workspaceId: 'workspace', agentPreset: 'standard' } }))
  expect(lines.some(line => line.includes('session preallocation unavailable'))).toBe(true)
  expect(run.id).toBe('session-host-assigned')
  await run.dispose()
})
it('continues an existing session: verifies it, adopts it and delivers the task without creating a new session', async () => {
  const f = fixture()
  const retained = 'session-retained-1'
  f.listed.push({ sessionId: retained, cwd: f.workspace.path, agentPreset: 'standard' })
  f.sessions.create.mockResolvedValue({ rpcId: 'fixture', result: { ok: true, value: { sessionId: retained } } } as never)
  const lines: string[] = []
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'continue work', new AbortController().signal, { progress: line => lines.push(line) })
  // The adopted session is prompted directly; no new identity is requested and the title stays put.
  expect(f.sessions.create).toHaveBeenCalledOnce()
  expect(f.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: retained, workspaceId: 'workspace' } }))
  expect(f.sessions.rename).not.toHaveBeenCalled()
  expect(f.sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: retained, mode: 'queue', content: expect.arrayContaining([{ type: 'text', text: 'continue work' }]) } }))
  expect(lines.some(line => line.includes(`continuing session ${retained}`))).toBe(true)
  expect(run.id).toBe(retained)
  expect(await run.result).toMatchObject({ stopReason: 'error' })
  await run.dispose()
})
it('continues a still-running session with an explicit queue note', async () => {
  const f = fixture()
  const retained = 'session-busy'
  f.listed.push({ sessionId: retained, cwd: f.workspace.path, running: true })
  f.sessions.create.mockResolvedValue({ rpcId: 'fixture', result: { ok: true, value: { sessionId: retained } } } as never)
  const lines: string[] = []
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'queued work', new AbortController().signal, { progress: line => lines.push(line) })
  expect(lines.some(line => line.includes('queues behind its current turn'))).toBe(true)
  await run.dispose()
})
it('rejects an unknown or foreign-workspace session id before adopting anything', async () => {
  const f = fixture()
  await expect(continueNativeRun(f.ctx, f.workspace, f.parent, 'session-ghost', 'x', new AbortController().signal)).rejects.toThrow('was not found')
  expect(f.sessions.create).not.toHaveBeenCalled()
  f.listed.push({ sessionId: 'session-foreign', cwd: '/somewhere/else' })
  await expect(continueNativeRun(f.ctx, f.workspace, f.parent, 'session-foreign', 'x', new AbortController().signal)).rejects.toThrow('belongs to /somewhere/else')
  expect(f.sessions.create).not.toHaveBeenCalled()
})
it('accepts a session whose cwd is unrecorded and still verifies existence', async () => {
  const f = fixture()
  const retained = 'session-no-cwd'
  f.listed.push({ sessionId: retained })
  f.sessions.create.mockResolvedValue({ rpcId: 'fixture', result: { ok: true, value: { sessionId: retained } } } as never)
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'x', new AbortController().signal)
  expect(f.sessions.prompt).toHaveBeenCalledOnce()
  await run.dispose()
})