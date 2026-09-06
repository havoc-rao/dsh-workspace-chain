import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { startNativeRun } from '../src/native.js'
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'native-lifecycle-'))); roots.push(path)
  const workspace = { id: 'workspace', path } as Workspace
  const parent = { id: 'parent' } as Agent
  const child = { session: { events: [] }, whenIdle: vi.fn(async () => {}) }
  const ok = (value: unknown) => ({ rpcId: 'fixture', result: { ok: true, value } })
  const sessions = {
    list: vi.fn(async () => ok({ items: [{ sessionId: 'parent', agentPreset: 'standard' }] })),
    create: vi.fn(async () => ok({ sessionId: 'child' })),
    rename: vi.fn(async () => ok({ title: 'pinned', seq: 1 })),
    prompt: vi.fn(async () => ok({ accepted: true })),
    cancel: vi.fn(async () => ok({ accepted: true })),
  }
  const ctx = { get: (name: string) => name === 'apiProxy' ? { sessions } : { get: () => workspace }, agents: { get: () => child } } as unknown as Context
  return { ctx, workspace, parent, child, sessions }
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
