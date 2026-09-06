import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { ApiProxy, RpcId as RpcIdType } from '@deepseek-ai/dsh-host-apiproxy'
import { randomUUID } from 'node:crypto'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { workspaceReference } from '../src/shared/references.js'
import * as chain from '../src/index.js'
const RpcId = (value: string) => value as RpcIdType
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
it('uses the local API contract and a real agent loop for an unconfigured workspace and retains a continuable session', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-chain-'))); roots.push(root)
  const cwd = join(root, 'target'); await mkdir(cwd)
  const file = join(root, 'host.json')
  await writeFile(file, JSON.stringify([
    { name: resolve('lib/child-runtime.js') },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl')), config: { root: join(root, 'sessions'), compression: 'none' } },
    ...['dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-subagent', 'dsh-tool-jobs'].map(name => ({
      name: fileURLToPath(import.meta.resolve(`@deepseek-ai/${name}`)),
      config: name === 'dsh-storage-json' ? { root: join(root, 'storage') } : name === 'dsh-storage-domain' ? { backend: 'json' } : {},
    })),
    { name: resolve('tests/fixtures/native-llm.mjs') },
  ]))
  const ctx = await boot('native-chain-test', file)
  try {
    // Contract fixture at the host boundary; the registry, loop and tools below are real.
    // The cached apiproxy package has incompatible transitive api-remotes exports,
    // so importing its implementation is not a valid integration environment here.
    const renames: { sessionId: string; title: string }[] = []
    const sessions: Pick<ApiProxy['sessions'], 'list' | 'create' | 'rename' | 'prompt' | 'cancel'> = {
      async list(r) { return { rpcId: r.rpcId, result: { ok: true, value: { items: ctx.sessions.list().map(s => ({ sessionId: s.id, updatedAt: 0, running: false, blank: false })) } } } },
      async create(r) {
        const w = r.payload.workspaceId ? ctx.workspaceRegistry.get(r.payload.workspaceId) : undefined
        const h = await ctx.agents.create({ sessionId: SessionId(`session-${randomUUID()}`), meta: { cwd: w?.path ?? root }, agentOptions: { provider: 'native-fixture', model: 'native-model' } })
        if (w) await w.attachSession(h.agent.id)
        return { rpcId: r.rpcId, result: { ok: true, value: { sessionId: h.agent.id } } }
      },
      async rename(r) {
        renames.push({ sessionId: r.payload.sessionId, title: r.payload.title })
        return { rpcId: r.rpcId, result: { ok: true, value: { title: r.payload.title, seq: 1 } } }
      },
      async prompt(r) {
        const agent = ctx.agents.get(r.payload.sessionId)!
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: r.payload.content as { type: 'text'; text: string }[] }))
        return { rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }
      },
      async cancel(r) {
        ctx.agents.get(r.payload.sessionId)!.cancel({ kind: 'parent' })
        return { rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }
      },
    }
    const api = { sessions } as ApiProxy
    ctx.provide('apiProxy', api)
    const workspace = await ctx.workspaceRegistry.create(cwd, 'Target')
    const parentResult = await api.sessions.create({ rpcId: RpcId('parent'), payload: {} })
    expect(parentResult.result.ok).toBe(true)
    if (!parentResult.result.ok) throw Error(parentResult.result.error.message)
    const parent = ctx.agents.get(parentResult.result.value.sessionId)!
    parent.ctx.tools.presentAs('native')
    const before = await ctx.systemPrompt.assemble({ scope: parent })
    await ctx.plugin(chain, {})
    const after = await ctx.systemPrompt.assemble({ scope: parent })
    expect(after.tools).toEqual(before.tools)
    expect(after.sections).toEqual(before.sections)
    parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${workspaceReference(workspace.id, workspace.title)} 给他发送一个你好。` }] }))
    await parent.whenIdle()
    expect(workspace.sessionIds).toHaveLength(1)
    const child = ctx.agents.get(workspace.sessionIds[0]!)!
    expect(child.session.header.cwd).toBe(cwd)
    const events = child.session.snapshotEvents()
    expect(JSON.stringify(events)).toContain('Native completed:')
    expect(JSON.stringify(events)).toContain('你好')
    expect(JSON.stringify(events)).not.toContain('@workspace-id/')
    expect(JSON.stringify(parent.session.snapshotEvents())).toContain('Integrated:')
    const prompt = await api.sessions.prompt({ rpcId: RpcId('continue'), payload: { sessionId: child.id, mode: 'queue', content: [{ type: 'text', text: '继续' }] } })
    expect(prompt.result.ok).toBe(true)
    await child.whenIdle()
    expect(JSON.stringify(child.session.snapshotEvents())).toContain('继续')
    const tool = ctx.tools.get('delegate_workspace')!
    const exec = { agent: parent, signal: AbortSignal.timeout(5000) } as unknown as ToolRunContext
    await expect(tool.execute({ target: root, task: 'do not run' }, exec)).rejects.toThrow('Unknown workspace target')
    const output = await tool.execute({ target: cwd, task: '/not-a-command' }, exec) as { sessionId: string; output: string; delegationId: string; checkpointPath: string }
    expect(output.sessionId).toBeTruthy()
    expect(output.output).toContain('/not-a-command')
    expect(ctx.agents.get(SessionId(output.sessionId))).toBeDefined()
    // The delegation record is written into the target workspace with the host session identity.
    expect(output.delegationId).toMatch(/^dlg-/)
    const recordDir = join(cwd, '.dsh', 'delegations', output.delegationId)
    const taskBook = JSON.parse(await readFile(join(recordDir, 'task.json'), 'utf8'))
    expect(taskBook).toMatchObject({ mode: 'local', workspacePath: cwd, parentSessionId: parent.id, sessionId: output.sessionId, runId: output.sessionId, title: 'Target/not-a-command' })
    expect(taskBook.task).toContain('/not-a-command')
    // Every created session gets a pinned `项目/任务摘要` title via sessions.rename.
    const pinned = renames.find(entry => entry.sessionId === output.sessionId)
    expect(pinned?.title).toBe('Target/not-a-command')
    expect(await readFile(join(recordDir, 'task.md'), 'utf8')).toContain('| 任务标题 | Target/not-a-command |')
    const progress = await readFile(join(recordDir, 'progress.md'), 'utf8')
    expect(progress).toContain(`[start] session created ${output.sessionId}`)
    expect(progress).toContain('task delivered to the target session')
    expect(progress).toContain('[result] completed')
    const resume = await readFile(join(recordDir, 'resume.md'), 'utf8')
    expect(resume).toContain(output.sessionId)
    const background = await tool.execute({ target: cwd, task: 'background work', run_in_background: true }, exec) as { jobId: string; delegationId: string }
    const backgroundRecord = join(cwd, '.dsh', 'delegations', background.delegationId)
    expect(existsSync(join(backgroundRecord, 'task.json'))).toBe(true)
    const settled = await ctx.jobs.wait(JobId(background.jobId), 5000, parent)
    expect(settled.status).toBe('completed')
    const collected = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: background.jobId }, callId: 'collect-native' as never, agent: parent, signal: exec.signal })
    expect(collected.isError).toBe(false)
    expect(JSON.stringify(collected)).toContain('background work')
    expect(await readFile(join(backgroundRecord, 'progress.md'), 'utf8')).toContain('[result] completed')
    expect(workspace.sessionIds).toHaveLength(3)
  } finally { await ctx.fiber.dispose() }
}, 20000)
