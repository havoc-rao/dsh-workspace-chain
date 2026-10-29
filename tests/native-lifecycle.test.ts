import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { continueNativeRun, planSessionId, startNativeRun } from '../src/native.js'
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'native-lifecycle-'))); roots.push(path)
  const workspace = { id: 'workspace', path } as Workspace
  const parent = { id: 'parent', session: { header: { agentPreset: 'standard' } } } as Agent
  const child = { session: { events: [] }, whenIdle: vi.fn(async () => {}) }
  const listed: { sessionId: string; cwd?: string; running?: boolean }[] = [
    { sessionId: 'parent' },
  ]
  const controller = {
    list: vi.fn(async () => ({ items: listed })),
    create: vi.fn(async (request: { sessionId?: string }) => ({ sessionId: request.sessionId ?? 'child' })),
    rename: vi.fn(async () => ({ title: 'pinned', seq: 1 })),
    selectModel: vi.fn(async (_request: unknown) => ({})),
    prompt: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => ({ accepted: true })),
  }
  const ctx = { get: (name: string) => name === 'sessionController' ? controller as unknown as SessionController : { get: () => workspace }, agents: { get: () => child } } as unknown as Context
  return { ctx, workspace, parent, child, controller, listed }
}
it('selects an explicit model before prompting and does not switch an unspecified model', async () => {
  const f = fixture()
  const model = { provider: 'openai', model: 'gpt-6.1' }
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { model })
  await run.dispose()
  expect(f.controller.selectModel).toHaveBeenCalledWith({ sessionId: 'child', ...model })
  expect(f.controller.selectModel.mock.invocationCallOrder[0]).toBeLessThan(f.controller.prompt.mock.invocationCallOrder[0]!)
  f.controller.selectModel.mockClear()
  await (await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal)).dispose()
  expect(f.controller.selectModel).not.toHaveBeenCalled()
})
it('does not deliver a task if explicit model switching fails', async () => {
  const f = fixture()
  f.controller.selectModel.mockRejectedValue(new Error('model unavailable'))
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { model: { provider: 'openai', model: 'gpt-6.1' } })
  expect(await run.result).toMatchObject({ stopReason: 'error', diagnostic: expect.stringContaining('model unavailable') })
  expect(f.controller.prompt).not.toHaveBeenCalled()
  await run.dispose()
})
it('waits for a running retained session to finish before switching its model', async () => {
  const f = fixture()
  f.listed.push({ sessionId: 'child', cwd: f.workspace.path, running: true })
  let idle!: () => void
  f.child.whenIdle.mockImplementationOnce(() => new Promise<void>(resolve => { idle = resolve }))
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, 'child', 'task', new AbortController().signal, { model: { provider: 'openai', model: 'gpt-6.1' } })
  expect(f.controller.selectModel).not.toHaveBeenCalled()
  expect(f.controller.prompt).not.toHaveBeenCalled()
  idle()
  await run.dispose()
  expect(f.controller.selectModel).toHaveBeenCalledOnce()
  expect(f.controller.prompt).toHaveBeenCalledOnce()
})
it('never switches or delivers after cancellation while waiting for a retained session', async () => {
  const f = fixture()
  f.listed.push({ sessionId: 'child', cwd: f.workspace.path, running: true })
  let idle!: () => void
  const pending = new Promise<void>(resolve => { idle = resolve })
  f.child.whenIdle.mockImplementation(() => pending)
  const controller = new AbortController()
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, 'child', 'task', controller.signal, { model: { provider: 'openai', model: 'gpt-6.1' } })
  controller.abort()
  idle()
  expect(await run.result).toMatchObject({ stopReason: 'aborted' })
  await run.dispose()
  expect(f.controller.selectModel).not.toHaveBeenCalled()
  expect(f.controller.prompt).not.toHaveBeenCalled()
})
it('passes the effective preset and workspace identity to create; a failed prompt is not success', async () => {
  const f = fixture()
  f.controller.prompt.mockRejectedValue(new Error('no model'))
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'hello', new AbortController().signal)
  expect(f.controller.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', agentPreset: 'standard' }))
  expect(await run.result).toMatchObject({ stopReason: 'error', diagnostic: expect.stringContaining('no model') })
  await run.dispose()
})
it('does not create a session after cancellation or continue after create rejection', async () => {
  const f = fixture()
  await expect(startNativeRun(f.ctx, f.workspace, f.parent, 'hello', AbortSignal.abort())).rejects.toThrow()
  expect(f.controller.create).not.toHaveBeenCalled()
  f.controller.create.mockRejectedValue(new Error('attach failed'))
  await expect(startNativeRun(f.ctx, f.workspace, f.parent, 'hello', new AbortController().signal)).rejects.toThrow('attach failed')
  expect(f.controller.prompt).not.toHaveBeenCalled()
})
it('cancels again when abort races prompt admission, waits for idle and keeps the host session', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.controller.prompt.mockImplementation(async () => {
    controller.abort()
    return { accepted: true }
  })
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'hello', controller.signal)
  expect(await run.result).toMatchObject({ stopReason: 'aborted' })
  expect(f.controller.cancel).toHaveBeenCalledTimes(2)
  expect(f.child.whenIdle).toHaveBeenCalled()
  await run.dispose()
  expect(f.controller.cancel).toHaveBeenCalledTimes(2)
})
it('pins the derived title right after create and reports it through progress', async () => {
  const f = fixture()
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'Draw a chart', new AbortController().signal, { title: '绘画/绘制图表', progress: line => lines.push(line) })
  expect(f.controller.rename).toHaveBeenCalledTimes(1)
  expect(f.controller.rename).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child', title: '绘画/绘制图表' }))
  expect(lines.filter(line => line.includes('title pinned'))).toHaveLength(1)
  expect(f.controller.prompt).toHaveBeenCalledOnce()
  await run.dispose()
})
it('keeps delegating when title pinning fails and skips rename without a title', async () => {
  const f = fixture()
  f.controller.rename.mockRejectedValue(new Error('empty'))
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { title: '项目/任务', progress: line => lines.push(line) })
  expect(lines.some(line => line.includes('title not pinned'))).toBe(true)
  expect(f.controller.prompt).toHaveBeenCalledOnce()
  await run.dispose()
  const withoutTitle = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal)
  expect(f.controller.rename).toHaveBeenCalledTimes(1)
  await withoutTitle.dispose()
})
it('adopts a preallocated session id on create and records it in progress', async () => {
  const f = fixture()
  const planned = planSessionId()
  const lines: string[] = []
  const run = await startNativeRun(f.ctx, f.workspace, f.parent, 'task', new AbortController().signal, { sessionId: planned, progress: line => lines.push(line) })
  expect(f.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: planned, workspaceId: 'workspace', agentPreset: 'standard' }))
  expect(lines).toContain(`session created ${planned}`)
  expect(run.id).toBe(planned)
  await run.dispose()
})
it('continues an existing session: verifies it, adopts it and delivers the task without creating a new session', async () => {
  const f = fixture()
  const retained = 'session-retained-1'
  f.listed.push({ sessionId: retained, cwd: f.workspace.path })
  f.controller.create.mockResolvedValue({ sessionId: retained })
  const lines: string[] = []
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'continue work', new AbortController().signal, { progress: line => lines.push(line) })
  // The adopted session is prompted directly; no new identity is requested and the title stays put.
  expect(f.controller.create).toHaveBeenCalledOnce()
  expect(f.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retained, workspaceId: 'workspace' }))
  expect(f.controller.rename).not.toHaveBeenCalled()
  expect(f.controller.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retained, mode: 'queue', content: expect.arrayContaining([{ type: 'text', text: 'continue work' }]) }), expect.anything())
  expect(lines.some(line => line.includes(`continuing session ${retained}`))).toBe(true)
  expect(run.id).toBe(retained)
  expect(await run.result).toMatchObject({ stopReason: 'error' })
  await run.dispose()
})
it('continues a still-running session with an explicit queue note', async () => {
  const f = fixture()
  const retained = 'session-busy'
  f.listed.push({ sessionId: retained, cwd: f.workspace.path, running: true })
  f.controller.create.mockResolvedValue({ sessionId: retained })
  const lines: string[] = []
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'queued work', new AbortController().signal, { progress: line => lines.push(line) })
  expect(lines.some(line => line.includes('queues behind its current turn'))).toBe(true)
  await run.dispose()
})
it('rejects an unknown or foreign-workspace session id before adopting anything', async () => {
  const f = fixture()
  await expect(continueNativeRun(f.ctx, f.workspace, f.parent, 'session-ghost', 'x', new AbortController().signal)).rejects.toThrow('was not found')
  expect(f.controller.create).not.toHaveBeenCalled()
  f.listed.push({ sessionId: 'session-foreign', cwd: '/somewhere/else' })
  await expect(continueNativeRun(f.ctx, f.workspace, f.parent, 'session-foreign', 'x', new AbortController().signal)).rejects.toThrow('belongs to /somewhere/else')
  expect(f.controller.create).not.toHaveBeenCalled()
})
it('accepts a session whose cwd is unrecorded and still verifies existence', async () => {
  const f = fixture()
  const retained = 'session-no-cwd'
  f.listed.push({ sessionId: retained })
  f.controller.create.mockResolvedValue({ sessionId: retained })
  const run = await continueNativeRun(f.ctx, f.workspace, f.parent, retained, 'x', new AbortController().signal)
  expect(f.controller.prompt).toHaveBeenCalledOnce()
  await run.dispose()
})