import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { collectRun, createDelegationTool } from '../src/tool.js'
import { workspacePrompt } from '../src/prompt.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-tool-')); roots.push(cwd)
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async () => ({ id: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), dispose }))
  const jobs = { start: vi.fn() }
  const ctx = { subagents: { start }, get: (key: string) => key === 'jobs' ? jobs : undefined } as unknown as Context
  const config = resolveConfig({ defaultTimeoutMs: 30, targets: { b: { cwd, command: 'node', purpose: 'Backend' } } })
  const tool = createDelegationTool(ctx, config)
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
  return { cwd, tool, exec, start, dispose, config, jobs }
}
describe('delegation tool', () => {
  it('fails unknown targets and deleted directories before spawning', async () => {
    const f = fixture()
    await expect(f.tool.execute({ target: 'constructor', task: 'x' }, f.exec)).rejects.toThrow('Available targets: b')
    rmSync(f.cwd, { recursive: true })
    await expect(f.tool.execute({ target: 'b', task: 'x' }, f.exec)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
  })
  it('sends only the standalone task and disposes after foreground completion', async () => {
    const f = fixture()
    expect(await f.tool.execute({ target: 'b', task: 'Implement API' }, f.exec)).toEqual({ kind: 'foreground', output: 'done', runId: 'child-1' })
    expect(f.start).toHaveBeenCalledWith('workspace-chain:delegate_workspace:b', expect.objectContaining({ parent: f.exec.agent, prompt: [{ type: 'text', text: 'Implement API' }], signal: expect.any(AbortSignal) }))
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(workspacePrompt(f.config)).toContain('Backend')
  })
  it.each(['aborted', 'error', 'max-tokens', 'refusal', 'future-reason'])('preserves diagnostics and partial text for %s', async stopReason => {
    const dispose = vi.fn(async () => {})
    await expect(collectRun({ id: 'child-1', result: Promise.resolve({ stopReason, diagnostic: 'wire detail', output: [{ type: 'text', text: 'partial' }] }), dispose } as unknown as SubagentRun)).rejects.toThrow(`${stopReason}\nDiagnostic: wire detail\nPartial output:\npartial`)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('preserves both execution and disposal failures', async () => {
    await expect(collectRun({ result: Promise.reject(new Error('run failed')), dispose: async () => { throw new Error('cleanup failed') } } as unknown as SubagentRun)).rejects.toThrow('run failed; dispose failed: Error: cleanup failed')
  })
  it('propagates cancellation and timeout to startup', async () => {
    const f = fixture()
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('cancelled')
    })
    await expect(f.tool.execute({ target: 'b', task: 'wait' }, f.exec)).rejects.toThrow('cancelled')
  })
  it('registers a parent-owned background task and collects its result', async () => {
    const f = fixture()
    let producer: any
    f.jobs.start.mockImplementation(spec => { expect(spec.owner).toBe(f.exec.agent); producer = spec.run(); return 'job-1' })
    expect(await f.tool.execute({ target: 'b', task: 'x', run_in_background: true }, f.exec)).toEqual({ kind: 'background', jobId: 'job-1' })
    expect(await producer.done).toEqual({ status: 'completed', output: 'done' })
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('settles job_kill during provider startup as killed', async () => {
    const f = fixture()
    let producer: any
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('startup cancelled')
    })
    f.jobs.start.mockImplementation(spec => { producer = spec.run(); return 'job-1' })
    await f.tool.execute({ target: 'b', task: 'x', run_in_background: true }, f.exec)
    producer.cancel('user stopped job')
    expect(await producer.done).toMatchObject({ status: 'killed' })
  })
  it('allows independent parallel foreground calls', async () => {
    const f = fixture()
    await Promise.all([1, 2].map(i => f.tool.execute({ target: 'b', task: `task ${i}` }, f.exec)))
    expect(f.start).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledTimes(2)
  })
})
