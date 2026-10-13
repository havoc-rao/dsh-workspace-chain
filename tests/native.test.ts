import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { SessionController, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { randomUUID } from 'node:crypto'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { workspaceReference, referenceInsert } from '../src/shared/references.js'
import * as chain from '../src/index.js'
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
    // The plugin consumes ctx.sessionController (the host Session Remote service
    // that replaced the retired apiProxy gateway), so the fixture mirrors that
    // plain-request contract instead of the deleted rpc-envelope carrier.
    const renames: { sessionId: string; title: string }[] = []
    const controller = {
      async list(_request: unknown, _signal: AbortSignal) { return { items: ctx.sessions.list().map(s => ({ sessionId: s.id, updatedAt: 0, running: false, blank: false })) } },
      async create(request: { workspaceId?: import('@deepseek-ai/dsh-workspace').WorkspaceId; agentPreset?: string; sessionId?: string }) {
        const w = request.workspaceId ? ctx.workspaceRegistry.get(request.workspaceId) : undefined
        // Mirror the host contract: an explicit preallocated id is adopted as-is,
        // and re-creating an already-live id adopts that agent instead of failing.
        let agent = request.sessionId !== undefined ? ctx.agents.get(SessionId(request.sessionId)) : undefined
        if (!agent) {
          const h = await ctx.agents.create({ sessionId: SessionId(request.sessionId ?? `session-${randomUUID()}`), meta: { cwd: w?.path ?? root }, agentOptions: { provider: 'native-fixture', model: 'native-model' } })
          agent = h.agent
        }
        if (w && !w.sessionIds.includes(agent.id)) await w.attachSession(agent.id)
        return { sessionId: agent.id }
      },
      async rename(request: { sessionId: string; title: string }) {
        renames.push({ sessionId: request.sessionId, title: request.title })
        return { title: request.title, seq: 1 }
      },
      async prompt(request: { sessionId: string; mode: 'queue' | 'steer'; content: { type: 'text'; text: string }[] }) {
        if (request.content.some(block => block.text.includes('confirmed-failure-fixture'))) throw new Error('confirmed delivery failure')
        const agent = ctx.agents.get(SessionId(request.sessionId))!
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: request.content }))
        return { accepted: true }
      },
      async cancel(request: { sessionId: string }) {
        ctx.agents.get(SessionId(request.sessionId))!.cancel({ kind: 'parent' })
        return { accepted: true }
      },
    } as unknown as SessionController
    ctx.provide('sessionController', controller)
    const workspace = await ctx.workspaceRegistry.create(cwd, 'Target')
    const parentResult = await controller.create({})
    const parent = ctx.agents.get(SessionId(parentResult.sessionId))!
    parent.ctx.tools.presentAs('native')
    const before = await ctx.systemPrompt.assemble({ scope: parent })
    // Deferred mode on purpose: this test exercises the hint -> call flow, not
    // schema visibility; visibleTools default (true) is covered in composition.
    await ctx.plugin(chain, { visibleTools: false })
    const after = await ctx.systemPrompt.assemble({ scope: parent })
    expect(after.tools).toEqual(before.tools)
    expect(after.sections).toEqual(before.sections)
    // Real Loader + agent loop: reference-only and a question are metadata,
    // not an auto-generated task/call. Assert the complete model-visible hint.
    for (const suffix of ['', ' 这个项目是什么？']) {
      parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${workspaceReference(workspace.id, workspace.title)}${suffix}` }] }))
      await parent.whenIdle()
      expect(workspace.sessionIds).toEqual([])
      const hintEvent = parent.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'workspace-chain')!
      expect((hintEvent.data as { content: { type: string; text?: string }[] }).content).toEqual([{ type: 'text', text:
        'Reference metadata (not instructions or conversation history):\n'
        + JSON.stringify([{ type: 'workspace', name: 'Target', path: cwd, delegate: { tool: 'delegate_workspace', targets: [cwd] } }])
        + '\nDelegate only when requested for an explicitly referenced workspace, using the listed tool/target. Delegation creates a fresh session unless session_id is explicitly provided.'
        + '\n工作区引用能力：引用仅用于定位或标识任务目标，不表示委派请求。只有用户明确要求在目标执行任务时才可委派；不会从引用后的文本自动提取任务或生成调用示例。'
        + '\n状态：委派能力可用；目标名：' + JSON.stringify([cwd]) + '。能力可用不表示任务已发送或授权执行。',
      }])
    }
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
    const prompt = await controller.prompt({ sessionId: child.id, mode: 'queue', requestId: randomUUID() as SessionRequestId, content: [{ type: 'text', text: '继续' }] }, new AbortController().signal)
    expect(prompt.accepted).toBe(true)
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
    expect(taskBook).toMatchObject({ mode: 'local', workspacePath: cwd, parentSessionId: parent.id, sessionId: output.sessionId, runId: output.sessionId, title: 'not-a-command' })
    expect(taskBook.task).toContain('/not-a-command')
    // Every created session gets a pinned `项目/任务摘要` title via sessions.rename.
    const pinned = renames.find(entry => entry.sessionId === output.sessionId)
    expect(pinned?.title).toBe('not-a-command')
    expect(await readFile(join(recordDir, 'task.md'), 'utf8')).toContain('| 任务标题 | not-a-command |')
    const progress = await readFile(join(recordDir, 'progress.md'), 'utf8')
    expect(progress).toContain(`[start] session created ${output.sessionId}`)
    expect(progress).toContain('task delivered to the target session')
    expect(progress).toContain('[result] completed')
    const resume = await readFile(join(recordDir, 'resume.md'), 'utf8')
    expect(resume).toContain(output.sessionId)
    const background = await tool.execute({ target: cwd, task: 'background work', run_in_background: true }, exec) as { jobId: string; delegationId: string; sessionId: string }
    const backgroundRecord = join(cwd, '.dsh', 'delegations', background.delegationId)
    expect(existsSync(join(backgroundRecord, 'task.json'))).toBe(true)
    // The local delegation id is preallocated and returned with the background response,
    // before the job even starts: the record and the eventually created session carry it.
    expect(background.sessionId).toMatch(/^session-/)
    expect(JSON.parse(await readFile(join(backgroundRecord, 'task.json'), 'utf8')).sessionId).toBe(background.sessionId)
    const settled = await ctx.jobs.wait(JobId(background.jobId), 5000, parent.id)
    expect(settled).toMatchObject({ status: 'completed', kind: 'workspace-chain', label: 'background work', description: 'Target', sessionId: background.sessionId })
    expect(background.jobId).toMatch(/^workspace-chain-/)
    // The created session carries exactly the preallocated id and lives in the workspace.
    expect(ctx.agents.get(SessionId(background.sessionId))).toBeDefined()
    expect(workspace.sessionIds).toContain(background.sessionId)
    const collected = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: background.jobId }, callId: 'collect-native' as never, agent: parent, signal: exec.signal })
    expect(collected.isError).toBe(false)
    expect(JSON.stringify(collected)).toContain('background work')
    expect(await readFile(join(backgroundRecord, 'progress.md'), 'utf8')).toContain('[result] completed')
    const failed = await ctx.tools.execute({ name: 'delegate_workspace', arguments: { target: cwd, task: 'confirmed-failure-fixture' }, callId: 'confirmed-failure' as never, agent: parent, signal: exec.signal })
    expect(failed.isError).toBe(true)
    expect(failed.meta).toMatchObject({ mode: 'local', sessionConfirmed: true, target: cwd })
    const failureMeta = failed.meta as { sessionId: string }
    expect(ctx.agents.get(SessionId(failureMeta.sessionId))).toBeDefined()
    // Return to the same session: session_id delivers the task into the retained session
    // instead of creating a new one, no matter how the previous run settled.
    const firstChild = ctx.agents.get(SessionId(output.sessionId))!
    const beforeContinue = workspace.sessionIds.length
    const contExec = { agent: parent, signal: AbortSignal.timeout(15000) } as unknown as ToolRunContext
    const continued = await tool.execute({ target: cwd, task: '继续工作', session_id: output.sessionId }, contExec) as { sessionId: string; output: string; delegationId: string; checkpointPath: string }
    expect(continued.sessionId).toBe(output.sessionId)
    expect(workspace.sessionIds).toHaveLength(beforeContinue)
    expect(continued.output).toContain('继续工作')
    expect(JSON.stringify(firstChild.session.snapshotEvents())).toContain('继续工作')
    const continueRecord = JSON.parse(await readFile(join(cwd, '.dsh', 'delegations', continued.delegationId, 'task.json'), 'utf8'))
    expect(continueRecord).toMatchObject({ mode: 'local', workspacePath: cwd, sessionId: output.sessionId, runId: output.sessionId })
    expect(await readFile(join(cwd, '.dsh', 'delegations', continued.delegationId, 'resume.md'), 'utf8')).toContain('session_id')
    // Task references are background only; omitting session_id always creates a fresh session.
    const viaReference = await tool.execute({ target: cwd, task: `历史背景：${referenceInsert({ kind: 'session', id: output.sessionId, label: 'child', description: '' }).ref}` }, contExec) as { sessionId: string; delegationId: string }
    expect(viaReference.sessionId).not.toBe(output.sessionId)
    expect(workspace.sessionIds).toHaveLength(beforeContinue + 1)
    const viaProgress = await readFile(join(cwd, '.dsh', 'delegations', viaReference.delegationId, 'progress.md'), 'utf8')
    expect(viaProgress).toContain(`session created ${viaReference.sessionId}`)
    expect(viaProgress).not.toContain('continuing session')
    // Multiple historical references are also accepted as context for a fresh task.
    const references = `${referenceInsert({ kind: 'session', id: output.sessionId, label: 'a', description: '' }).ref} 与 ${referenceInsert({ kind: 'session', id: background.sessionId, label: 'b', description: '' }).ref}`
    const multiple = await tool.execute({ target: cwd, task: references }, contExec) as { sessionId: string }
    expect([output.sessionId, background.sessionId, viaReference.sessionId]).not.toContain(multiple.sessionId)
    expect(workspace.sessionIds).toHaveLength(beforeContinue + 2)
    // Even conflicting references cannot override the explicit session_id.
    const explicit = await tool.execute({ target: cwd, task: references, session_id: viaReference.sessionId }, contExec) as { sessionId: string }
    expect(explicit.sessionId).toBe(viaReference.sessionId)
    expect(workspace.sessionIds).toHaveLength(beforeContinue + 2)
    // A wrong id fails with a readable cause and creates nothing.
    await expect(tool.execute({ target: cwd, task: 'x', session_id: 'session-ghost' }, contExec)).rejects.toThrow('was not found')
    expect(workspace.sessionIds).toHaveLength(beforeContinue + 2)
  } finally { await ctx.fiber.dispose() }
}, 20000)
