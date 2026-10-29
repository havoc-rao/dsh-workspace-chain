import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { collectRun, createDelegationTool } from '../src/tool.js'
import { invocationHint } from '../src/presentation.js'
import { referenceInsert } from '../src/shared/references.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(options: { records?: boolean; timeoutExtensionMs?: number; maxTimeoutExtensions?: number } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'chain-tool-')); roots.push(cwd)
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async () => ({ id: 'child-1', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), dispose }))
  const jobs = { start: vi.fn() }
  const setSession = vi.fn()
  const ctx = { on: vi.fn(), subagents: { start }, get: (key: string) => key === 'jobs' ? jobs : undefined } as unknown as Context
  // shareSessionStore: false keeps the activity probe's session-store reads inside the temp dir.
  const config = resolveConfig({
    defaultTimeoutMs: 30, timeoutExtensionMs: options.timeoutExtensionMs ?? 60, maxTimeoutExtensions: options.maxTimeoutExtensions ?? 5,
    shareSessionStore: false, delegationRecords: options.records ?? true,
    targets: { b: { cwd, purpose: 'Backend' } },
  })
  const tool = createDelegationTool(ctx, config)
  const agent = { id: 'parent-1', session: { header: { cwd } } }
  const exec = { signal: new AbortController().signal, agent } as unknown as ToolRunContext
  return { ctx, cwd, tool, exec, agent, start, dispose, config, jobs, setSession }
}
function records(cwd: string): string[] {
  const dir = join(cwd, '.dsh', 'delegations')
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : []
}
function progressOf(cwd: string, name: string): string {
  return readFileSync(join(records(cwd)[0]!, name), 'utf8')
}
const envelope = /\[委派任务书 delegationId=dlg-\d{8}-[0-9a-f]{8}\]\n任务书文件: .*\n进度协议: .*\n---- 任务原文 ----\n[\s\S]*\n---- 任务结束 ----/
describe('delegation tool', () => {
  it('fails unknown targets and deleted directories before spawning', async () => {
    const f = fixture()
    await expect(f.tool.execute({ target: 'constructor', task: 'x' }, f.exec)).rejects.toThrow('Available targets: b')
    rmSync(f.cwd, { recursive: true })
    await expect(f.tool.execute({ target: 'b', task: 'x' }, f.exec)).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
  })
  it('keeps empty model selection on defaults and rejects a provider without a model', async () => {
    const f = fixture()
    await f.tool.execute({ target: 'b', task: 'x', model_id: ' ', provider_id: '' }, f.exec)
    expect(f.start).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ agentOptions: expect.anything() }))
    await expect(f.tool.execute({ target: 'b', task: 'x', provider_id: 'openai' }, f.exec)).rejects.toThrow('requires a non-empty model_id')
  })
  it('resolves explicit models into SDK route overrides and durable task records', async () => {
    const f = fixture()
    Object.assign(f.ctx, { llm: { listProviders: () => [{ id: 'openai', name: 'OpenAI' }], listModels: async () => [{ id: 'gpt-6.1', name: 'GPT' }] } })
    const result = await f.tool.execute({ target: 'b', task: 'x', model_id: 'gpt-6.1', provider_id: 'openai' }, f.exec) as { checkpointPath: string }
    expect(f.start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentOptions: { provider: 'openai', model: 'gpt-6.1' } }))
    expect(JSON.parse(readFileSync(join(dirname(result.checkpointPath), 'task.json'), 'utf8'))).toMatchObject({ modelId: 'gpt-6.1', providerId: 'openai' })
    expect(readFileSync(join(dirname(result.checkpointPath), 'resume.md'), 'utf8')).toContain('"model_id": "gpt-6.1"')
  })
  it('does not start a run when an explicit model cannot be resolved', async () => {
    const f = fixture()
    Object.assign(f.ctx, { llm: { listProviders: () => [] } })
    await expect(f.tool.execute({ target: 'b', task: 'x', model_id: 'unknown' }, f.exec)).rejects.toThrow('Unknown model_id')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('writes a task book, delivers the checkpoint envelope and disposes after foreground completion', async () => {
    const f = fixture()
    const result = await f.tool.execute({ target: 'b', task: 'Implement API' }, f.exec) as { kind: string; output: string; runId: string; delegationId: string; checkpointPath: string }
    expect(result).toMatchObject({ kind: 'foreground', output: 'done', runId: 'child-1' })
    expect(result.delegationId).toMatch(/^dlg-\d{8}-[0-9a-f]{8}$/)
    expect(result.checkpointPath).toContain(join('.dsh', 'delegations'))
    expect(f.start).toHaveBeenCalledWith('workspace-chain:delegate_workspace:b', expect.objectContaining({
      parent: f.exec.agent,
      prompt: [{ type: 'text', text: expect.stringMatching(envelope) }],
      signal: expect.any(AbortSignal),
    }))
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(invocationHint(f.ctx, f.config)).toContain('Deferred tool: delegate_workspace')
    const taskBook = JSON.parse(readFileSync(join(dirname(result.checkpointPath), 'task.json'), 'utf8'))
    expect(taskBook).toMatchObject({ mode: 'sdk', target: 'b', workspacePath: realpathSync(f.cwd), parentSessionId: 'parent-1', runId: 'child-1', timeoutMs: 30, title: 'Implement API' })
    const progress = readFileSync(result.checkpointPath, 'utf8')
    expect(progress).toContain('[init] delegation record created')
    expect(progress).toContain('[start] subagent created child-1 (SDK run id)')
    expect(progress).toContain('[result] completed')
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
  it('reports a crash with classification, transcript and resume paths on foreground failure', async () => {
    const f = fixture()
    f.start.mockResolvedValue({ id: 'child-1', result: Promise.resolve({ stopReason: 'error', diagnostic: 'loop crashed', output: [{ type: 'text', text: 'partial' }] }), dispose: vi.fn(async () => {}) } as never)
    const error = await f.tool.execute({ target: 'b', task: 'x' }, f.exec).then(() => null, (e: unknown) => e) as Error
    expect(error.message).toContain('Classification: crash')
    expect(error.message).toContain('elapsed')
    expect(error.message).toContain('child session store')
    expect(error.message).toContain('Resume:')
    expect(error.message).toContain('progress.md')
    expect(records(f.cwd)).toHaveLength(1)
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] crash')
  })
  it('reports timeout with elapsed, checkpoint and resume instructions', async () => {
    const f = fixture()
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('never started')
    })
    const error = await f.tool.execute({ target: 'b', task: 'hang' }, f.exec).then(() => null, (e: unknown) => e) as Error
    expect(error.message).toContain('Classification: timeout')
    expect(error.message).toContain('timed out')
    expect(error.message).toContain('Resume:')
    const elapsed = Number(error.message.match(/elapsed (\d+)ms/)?.[1])
    expect(elapsed).toBeGreaterThanOrEqual(20)
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] timeout')
    expect(progressOf(f.cwd, 'resume.md')).toContain('续跑任务书样例')
  })
  it('reports canceled when the caller aborts during the run', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.exec = { signal: controller.signal, agent: f.agent } as unknown as ToolRunContext
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      controller.abort()
      request.signal.throwIfAborted()
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('parent interrupted')
    })
    const error = await f.tool.execute({ target: 'b', task: 'x' }, f.exec).then(() => null, (e: unknown) => e) as Error
    expect(error.message).toContain('Classification: cancelled')
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] cancelled')
  })
  it('registers a parent-owned background task, streams progress and collects its result', async () => {
    const f = fixture()
    let resolveResult!: (value: unknown) => void
    let producer!: { done: Promise<unknown>; cancel: (reason?: string) => void; readOutput: () => string }
    f.start.mockResolvedValue({ id: 'child-1', result: new Promise(resolve => { resolveResult = resolve }), dispose: f.dispose } as never)
    f.jobs.start.mockImplementation((spec: any) => { expect(spec.owner).toBe(f.exec.agent!.id); producer = spec.run({ setSession: f.setSession }); return 'job-1' })
    const result = await f.tool.execute({ target: 'b', task: 'x', run_in_background: true }, f.exec) as { kind: string; jobId: string; delegationId: string }
    expect(result).toMatchObject({ kind: 'background', jobId: 'job-1' })
    expect(result.delegationId).toMatch(/^dlg-/)
    // While the child run is still pending, job_output sees the checkpoint summary.
    await vi.waitFor(() => expect(producer.readOutput()).toContain('[start] subagent created child-1 (SDK run id)'))
    const running = producer.readOutput()
    expect(running).toContain('delegation dlg-')
    expect(running).toContain('2 checkpoints')
    resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    expect(await producer.done).toEqual({ status: 'completed', result: 'done' })
    expect(producer.readOutput()).toBe('done')
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.jobs.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workspace-chain', label: 'x', description: 'b' }))
    expect(f.setSession).not.toHaveBeenCalled() // SDK run ids are not Host Sessions.
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] completed')
  })
  it('settles job_kill during provider startup as killed with canceled classification', async () => {
    const f = fixture()
    let producer!: { done: Promise<{ status: string; detail?: string }>; cancel: (reason?: string) => void }
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('startup cancelled')
    })
    f.jobs.start.mockImplementation((spec: any) => { producer = spec.run({ setSession: f.setSession }); return 'job-1' })
    await f.tool.execute({ target: 'b', task: 'x', run_in_background: true }, f.exec)
    producer.cancel('user stopped job')
    const outcome = await producer.done
    expect(outcome).toMatchObject({ status: 'killed' })
    expect(outcome.detail).toContain('Classification: cancelled')
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] cancelled')
  })
  it('fails a background job with timeout classification', async () => {
    const f = fixture()
    let producer!: { done: Promise<{ status: string; detail?: string }>; cancel: (reason?: string) => void }
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('hung')
    })
    f.jobs.start.mockImplementation((spec: any) => { producer = spec.run({ setSession: f.setSession }); return 'job-1' })
    await f.tool.execute({ target: 'b', task: 'x', run_in_background: true }, f.exec)
    const outcome = await producer.done
    expect(outcome).toMatchObject({ status: 'failed' })
    expect(outcome.detail).toContain('Classification: timeout')
    expect(outcome.detail).toContain('Resume:')
    expect(Number(outcome.detail?.match(/elapsed (\d+)ms/)?.[1])).toBeGreaterThanOrEqual(20)
  })
  it('applies the timeout_ms override and persists it in the task book', async () => {
    const f = fixture()
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('hung')
    })
    const error = await f.tool.execute({ target: 'b', task: 'x', timeout_ms: 5 }, f.exec).then(() => null, (e: unknown) => e) as Error
    expect(error.message).toContain('Classification: timeout')
    expect(JSON.parse(readFileSync(join(records(f.cwd)[0]!, 'task.json'), 'utf8')).timeoutMs).toBe(5)
  })
  it('rejects an invalid timeout_ms', async () => {
    const f = fixture()
    await expect(f.tool.execute({ target: 'b', task: 'x', timeout_ms: -1 }, f.exec)).rejects.toThrow('timeout_ms')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('rejects session_id on an SDK target and malformed values before spawning', async () => {
    const f = fixture()
    await expect(f.tool.execute({ target: 'b', task: 'x', session_id: 'session-1' }, f.exec)).rejects.toThrow('session_id requires a local workspace target')
    await expect(f.tool.execute({ target: 'b', task: 'x', session_id: 42 }, f.exec)).rejects.toThrow('"session_id" must be a string')
    await expect(f.tool.execute({ target: 'b', task: 'x', session_id: '   ' }, f.exec)).rejects.toThrow('session_id must be a non-empty string')
    expect(f.start).not.toHaveBeenCalled()
  })
  it.each([1, 2])('accepts %s historical session references in an SDK task without routing', async count => {
    const f = fixture({ records: false })
    const task = Array.from({ length: count }, (_, i) => referenceInsert({ kind: 'session', id: `session-${i}`, label: 'background', description: '' }).ref).join(' ')
    await expect(f.tool.execute({ target: 'b', task }, f.exec)).resolves.toEqual({ kind: 'foreground', output: 'done', runId: 'child-1' })
    expect(f.start).toHaveBeenCalledWith('workspace-chain:delegate_workspace:b', expect.objectContaining({ prompt: [{ type: 'text', text: task }] }))
  })
  it('accepts an explicit title and stores it in the task book', async () => {
    const f = fixture()
    const result = await f.tool.execute({ target: 'b', task: 'Implement API', title: '绘画/画一只猫' }, f.exec) as { delegationId: string }
    expect(JSON.parse(readFileSync(join(records(f.cwd)[0]!, 'task.json'), 'utf8')).title).toBe('绘画/画一只猫')
    expect(result.delegationId).toMatch(/^dlg-/)
  })
it('keeps the raw task when delegation records are disabled', async () => {
    const f = fixture({ records: false })
    expect(await f.tool.execute({ target: 'b', task: 'Plain task' }, f.exec)).toEqual({ kind: 'foreground', output: 'done', runId: 'child-1' })
    expect(f.start).toHaveBeenCalledWith('workspace-chain:delegate_workspace:b', expect.objectContaining({ prompt: [{ type: 'text', text: 'Plain task' }] }))
    expect(records(f.cwd)).toHaveLength(0)
  })
  it('continues without a checkpoint record when the record directory cannot be written', async () => {
    const f = fixture()
    writeFileSync(join(f.cwd, '.dsh'), 'not a directory')
    expect(await f.tool.execute({ target: 'b', task: 'x' }, f.exec)).toEqual({ kind: 'foreground', output: 'done', runId: 'child-1' })
    expect(f.start).toHaveBeenCalledOnce()
  })
  it('allows independent parallel foreground calls', async () => {
    const f = fixture()
    await Promise.all([1, 2].map(i => f.tool.execute({ target: 'b', task: `task ${i}` }, f.exec)))
    expect(f.start).toHaveBeenCalledTimes(2); expect(f.dispose).toHaveBeenCalledTimes(2)
    expect(records(f.cwd)).toHaveLength(2)
  })
  it('extends the foreground wait while the target agent is live and completes once the result arrives', async () => {
    const f = fixture()
    let resolveResult!: (value: { stopReason: string; output: { type: string; text: string }[] }) => void
    f.start.mockImplementation(async () => ({
      id: 'child-1',
      localAgent: { status: 'running' },
      result: new Promise(resolve => { resolveResult = resolve }),
      dispose: f.dispose,
    }) as never)
    const pending = f.tool.execute({ target: 'b', task: 'slow' }, f.exec) as Promise<{ kind: string; output: string }>
    // The 30ms base window must NOT abort while the agent is live: wait for the extension checkpoint.
    await vi.waitFor(() => expect(progressOf(f.cwd, 'progress.md')).toContain('[extend] target still active (target agent is live'))
    resolveResult({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    expect(await pending).toMatchObject({ kind: 'foreground', output: 'done' })
    expect(progressOf(f.cwd, 'progress.md')).toContain('[result] completed')
  })
  it('keeps extending while the target stays active and settles as timeout only at the extension cap', async () => {
    const f = fixture({ timeoutExtensionMs: 25, maxTimeoutExtensions: 3 })
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      const result = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return { id: 'child-1', localAgent: { status: 'running' }, result, dispose: f.dispose } as never
    })
    const error = await f.tool.execute({ target: 'b', task: 'cap' }, f.exec).then(() => null, (reason: unknown) => reason) as Error
    expect(error.message).toContain('Classification: timeout')
    expect(error.message).toContain('extension cap')
    expect(error.message).toContain('waited 30ms + 3×25ms')
    const granted = (progressOf(f.cwd, 'progress.md').match(/\[extend\]/g) ?? []).length
    expect(granted).toBe(3)
    const elapsed = Number(error.message.match(/elapsed (\d+)ms/)?.[1])
    expect(elapsed).toBeGreaterThanOrEqual(95)
  })
  it('waits out a session-store heartbeat and times out only after the store goes silent', async () => {
    const f = fixture({ timeoutExtensionMs: 40, maxTimeoutExtensions: 5 })
    const sessions = join(f.cwd, '.dsh-workspace-chain', 'sessions')
    mkdirSync(sessions, { recursive: true })
    const log = join(sessions, 'child.jsonl')
    writeFileSync(log, '')
    const touch = () => utimesSync(log, new Date(), new Date())
    touch()
    const beats = setInterval(touch, 20)
    f.start.mockImplementation(async (_provider?: unknown, request?: any) => {
      const result = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return { id: 'child-1', result, dispose: f.dispose } as never
    })
    const pending = f.tool.execute({ target: 'b', task: 'heartbeat' }, f.exec).then(() => null, (reason: unknown) => reason) as Promise<Error>
    await vi.waitFor(() => expect(progressOf(f.cwd, 'progress.md')).toContain('[extend] target still active'))
    clearInterval(beats)
    const error = await pending
    expect(error.message).toContain('Classification: timeout')
    expect(error.message).toContain('no target activity observed')
    expect(error.message).toContain('store')
    expect(progressOf(f.cwd, 'progress.md')).toContain('[extend] target still active (target session store heartbeat')
  })
  it('exposes the parallel-background and activity-aware timeout guidance in the invocation hint', () => {
    const f = fixture()
    const hint = invocationHint(f.ctx, f.config)
    expect(hint).toContain('Deferred tool: delegate_workspace')
    expect(hint).toContain('run_in_background: true 挂后台')
    expect(hint).toContain('超时是活动感知的')
    expect(hint).toContain('maxTimeoutExtensions')
    expect(hint).toContain('只有显式 session_id 控制续聊')
    expect(hint).not.toContain('执行层会把它解析为发送目标')
  })
})