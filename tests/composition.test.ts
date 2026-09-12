import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as chain from '../src/index.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function logs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return (await Promise.all(entries.map(e => e.isDirectory() ? logs(join(root, e.name)) : Promise.resolve(e.name.endsWith('.jsonl') ? [join(root, e.name)] : [])))).flat()
}
it.each([true, false])('real SDK child runtime: shared store=%s, cwd, scrub, persistence and parallel calls', async shared => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-composition-'))); roots.push(root)
  const home = join(root, 'parent-home'); const cwd = join(root, 'project-b'); await mkdir(cwd)
  vi.stubEnv('DSH_HOME', home); vi.stubEnv('CHAIN_SECRET_TOKEN', 'must-not-cross')
  // Exercise the shipped composition, replacing only the network model with a keyless adapter.
  let child = await readFile(resolve('src/child.cordis.yml'), 'utf8')
  child = child.replace('compression: zstd', 'compression: none')
  child = child.replace('../lib/child-runtime.js', JSON.stringify(resolve('lib/child-runtime.js')))
  child = child.replace("'@deepseek-ai/dsh-llm-deepseek'", JSON.stringify(resolve('tests/fixtures/mock-llm.mjs')))
  child = child.replace(/'(@deepseek-ai\/[^']+)'/g, (_match, pkg: string) => JSON.stringify(fileURLToPath(import.meta.resolve(pkg))))
  const childConfig = join(root, 'child.yml'); await writeFile(childConfig, child)
  const parentConfig = join(root, 'parent.yml')
  await writeFile(parentConfig, JSON.stringify([
    { name: resolve('lib/child-runtime.js') },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl')), config: { root: join(home, 'sessions'), compression: 'none' } },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-storage')) },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-storage-json')), config: { root: join(home, 'storages') } },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-storage-domain')), config: { backend: 'json' } },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-workspace')) },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subagent')) },
    { name: resolve('tests/fixtures/parent-llm.mjs') },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tool-jobs')) },
  ]))
  const ctx = await boot('chain-test-parent', parentConfig)
  try {
    const target = { cwd, command: process.execPath, args: [resolve('lib/child-bin.js'), childConfig], provider: 'mock', model: 'mock', env: { CHAIN_EXPLICIT: 'allowed' } }
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.ctx.tools.presentAs(shared ? 'native' : 'both')
    const prefixBefore = await ctx.systemPrompt.assemble({ scope: handle.agent })
    const nativeBefore = await ctx.systemPrompt.assemble({})
    await ctx.plugin(chain, { shareSessionStore: shared, defaultTimeoutMs: 20000, visibleTools: false, targets: shared ? { b: target } : { b: target, second: target } })
    const prefixAfter = await ctx.systemPrompt.assemble({ scope: handle.agent })
    const nativeAfter = await ctx.systemPrompt.assemble({})
    expect(prefixAfter.sections).toEqual(prefixBefore.sections)
    expect(prefixAfter.tools).toEqual(prefixBefore.tools)
    expect(nativeAfter.sections).toEqual(nativeBefore.sections)
    expect(nativeAfter.tools).toEqual(nativeBefore.tools)
    try {
      const tool = ctx.tools.get('delegate_workspace')!
      const exec = { agent: handle.agent, signal: AbortSignal.timeout(25000) } as unknown as ToolRunContext
      const results = await Promise.all([1, 2].map(i => tool.execute({ target: shared || i === 1 ? 'b' : 'second', task: `Report process state ${i}` }, exec))) as { kind: string; output: string; runId: string }[]
      for (const result of results) {
        expect(result.kind).toBe('foreground')
        expect(JSON.parse(result.output)).toEqual({ cwd, home: shared ? home : join(cwd, '.dsh-workspace-chain'), ambientSecret: null, explicit: 'allowed' })
      }
      const background = await tool.execute({ target: 'b', task: 'Background report', run_in_background: true }, exec) as { jobId: string }
      const settled = await ctx.jobs.wait(JobId(background.jobId), 20000, handle.agent)
      expect(settled.status).toBe('completed')
      const output = await ctx.tools.execute({ name: 'job_output', arguments: { job_id: background.jobId }, callId: 'collect' as never, agent: handle.agent, signal: exec.signal })
      expect(output.isError).toBe(false)
      expect(JSON.stringify(output)).toContain(cwd)
      // A real parent turn: query -> durable hint -> model tool call -> child -> A's integrated answer.
      const referencedWorkspace = shared ? await ctx.workspaceRegistry.create(cwd, 'space-labeler') : undefined
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: referencedWorkspace ? `@workspace-id/${referencedWorkspace.id} 给他发送一个你好。` : '请 @workspace/b 报告工作区，然后汇总结果。' }] }))
      await handle.agent.whenIdle()
      const events = handle.agent.session.snapshotEvents()
      expect(events.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin' && e.data.source.plugin === 'workspace-chain')).toBe(true)
      const toolResult = events.find(e => e.type === 'tool/result')
      expect(JSON.stringify(toolResult)).toContain(cwd)
      expect(JSON.stringify(events.findLast(e => e.type === 'assistant/message'))).toContain('Integrated child result:')
      const sessionLogs = await logs(join(shared ? home : join(cwd, '.dsh-workspace-chain'), 'sessions'))
      const childLogs = []
      for (const path of sessionLogs) { const first = (await readFile(path, 'utf8')).split('\n')[0]!; if (JSON.parse(first).cwd === cwd) childLogs.push(path) }
      expect(childLogs).toHaveLength(4)
      for (const path of childLogs) {
        const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        expect(JSON.stringify(lines[0])).toContain(cwd)
        expect(lines.some(line => line.type === 'user/message')).toBe(true)
        expect(lines.some(line => line.type === 'assistant/message')).toBe(true)
      }
      const workspace = ctx.workspaceRegistry.list().find(w => w.path === cwd)
      // SDK run ids are not child session ids. Do not publish false UI links or membership.
      if (shared) expect(workspace?.sessionIds).toEqual([])
      else expect(workspace).toBeUndefined()
      const parentHeaders = await ctx.sessionPersistence.list()
      expect(parentHeaders.filter(header => header.cwd === cwd)).toHaveLength(shared ? 4 : 0)
      for (const result of results) expect(parentHeaders.some(header => header.id === result.runId)).toBe(false)

    } finally { await handle.dispose() }
  } finally { await ctx.fiber.dispose() }
}, 60000)

it('boots the packaged default child composition over JSON-RPC without model calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-default-'))); roots.push(root)
  const harness = new DeepSeekHarness({
    launch: { command: process.execPath, args: [resolve('lib/child-bin.js')], cwd: root, env: { ...scrubbedParentEnv(), DSH_HOME: join(root, 'home') } },
    cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash',
  })
  try { await harness.start() } finally { await harness.close() }
}, 20000)

it('visible mode (default) keeps the delegation tool in the top-level schema; the hint no longer needs an out-of-schema call', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-visible-'))); roots.push(root)
  const cwd = join(root, 'target'); await mkdir(cwd)
  await writeFile(join(root, 'host.json'), JSON.stringify([
    { name: resolve('lib/child-runtime.js') },
    { name: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl')), config: { root: join(root, 'sessions'), compression: 'none' } },
    ...['dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace', 'dsh-subagent', 'dsh-tool-jobs'].map(name => ({
      name: fileURLToPath(import.meta.resolve(`@deepseek-ai/${name}`)),
      config: name === 'dsh-storage-json' ? { root: join(root, 'storage') } : name === 'dsh-storage-domain' ? { backend: 'json' } : {},
    })),
    { name: resolve('tests/fixtures/native-llm.mjs') },
  ]))
  const ctx = await boot('chain-visible-test', join(root, 'host.json'))
  try {
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd }, agentOptions: { provider: 'native-fixture', model: 'native-model' } })
    const agent = handle.agent
    try {
      agent.ctx.tools.presentAs('native')
      const before = await ctx.systemPrompt.assemble({ scope: agent })
      await ctx.plugin(chain, {})
      const after = await ctx.systemPrompt.assemble({ scope: agent })
      // Default visibleTools: true — the tool is a normal top-level tool now;
      // native mode is the deployment default and the mode this plugin's
      // deferred declaration was designed around.
      expect(before.tools.some(tool => tool.name === 'delegate_workspace')).toBe(false)
      expect(after.tools.some(tool => tool.name === 'delegate_workspace')).toBe(true)
      // Hidden mode (visibleTools: false) still strips it from the schema; the
      // SDK-section coverage of that path lives in the real-runtime tests above.
    } finally { await handle.dispose() }
  } finally { await ctx.fiber.dispose() }
}, 30000)
