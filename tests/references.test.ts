import { expect, it } from 'vitest'
import { REFERENCE_MIME, referenceInsert, resolveDrop, workspaceReferenceIds, type ReferenceItem } from '../src/shared/references.js'
import { mountWorkspaceHints, workspaceHint } from '../src/workspace-hints.js'
import { resolveConfig } from '../src/config.js'
const items: ReferenceItem[] = [
  { kind: 'workspace', id: 'w1', label: '项目', description: process.cwd() },
  { kind: 'session', id: 's1', label: '对话', description: '', workspaceId: 'w1' },
  { kind: 'session', id: 's2', label: '分支', description: '', workspaceId: 'w1', parentId: 's1' },
  { kind: 'session', id: 's3', label: '工具任务', description: '', workspaceId: 'w1', parentId: 's1', origin: 'subagent' },
]
it('emits native session references losslessly and escapes labels', () => {
  const id = '会话/"\\🙂'
  expect(referenceInsert({ kind: 'session', id, label: 'a]b\\c', description: '' }).ref).toBe(`@[a\\]b\\\\c](dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')})`)
})
it('resolves typed drag IDs against the current catalog and supports legacy workspace drags', () => {
  const transfer = (raw: string, text = '') => ({ getData: (type: string) => type === REFERENCE_MIME ? raw : text })
  expect(resolveDrop(transfer(JSON.stringify({ version: 1, kind: 'session', id: 's1' })), items)).toBe(items[1])
  expect(resolveDrop(transfer('', 'w1'), items)).toBe(items[0])
  for (const raw of ['{', 'null', JSON.stringify({ version: 2, kind: 'workspace', id: 'w1' }), JSON.stringify({ version: 1, kind: 'session', id: 'w1' })]) expect(resolveDrop(transfer(raw, 'w1'), items)).toBeUndefined()
  expect(resolveDrop(transfer('', process.cwd()), items)).toBeUndefined()
})
it('resolves workspace context even with no delegation target and never invents one', () => {
  expect(workspaceReferenceIds('@workspace-id/a%20b @workspace-id/a%20b @workspace-id/%ZZ')).toEqual(['a b'])
  const workspaces = [{ id: 'w1', title: '项目', path: process.cwd() }]
  const empty = workspaceHint('@workspace-id/w1', workspaces, resolveConfig(), true, false)!
  expect(empty).not.toContain('delegate')
  const config = resolveConfig({ targets: { configured: { cwd: process.cwd() } } })
  expect(workspaceHint('@workspace-id/w1', workspaces, config)).toContain('"targets":["configured"]')
  expect(workspaceHint('@workspace-id/missing', workspaces, config)).toContain('"unavailable":true')
})
it('keeps session membership as historical metadata without delegation targets', () => {
  const config = resolveConfig({ targets: { backend: { cwd: process.cwd() } } })
  const workspaces = [{ id: 'w1', title: 'Backend', path: process.cwd(), sessionIds: ['s1'] }]
  const query = referenceInsert(items[1]!).ref
  const hint = workspaceHint(query, workspaces, config)!
  expect(hint).not.toContain('"targets"')
  expect(hint).not.toContain('"delegate"')
  expect(hint).toContain('historical background only')
  expect(workspaceHint(query, workspaces, config, false)).not.toContain('delegate')
  expect(workspaceHint(query, [], config)).not.toContain('delegate')
  expect(workspaceHint(query, [], config)).not.toContain('"targets":["backend"]')
})
it('projects registry getters without disclosing records, IDs, session lists, or logos', () => {
  const record = { title: 'Project', path: process.cwd(), sessionIds: ['private-session-id'], logo: 'data:image/svg+xml;base64,SECRET' }
  const entity = {
    host: {}, record, id: 'private-workspace-id',
    get title() { return this.record.title },
    get path() { return this.record.path },
    get sessionIds() { return this.record.sessionIds },
  }
  const hint = workspaceHint('@workspace-id/private-workspace-id', [entity], resolveConfig())!
  expect(JSON.parse(hint.split('\n')[1]!)).toEqual([{ type: 'workspace', name: 'Project', path: process.cwd(), delegate: { tool: 'delegate_workspace', targets: [process.cwd()] } }])
  for (const forbidden of ['private-workspace-id', 'private-session-id', 'host', 'record', 'logo', 'base64', 'SECRET', 'calls', 'toolAvailable']) expect(hint).not.toContain(forbidden)
  const sessionHint = workspaceHint(referenceInsert({ kind: 'session', id: 'private-session-id', label: 'Review', description: '' }).ref, [entity], resolveConfig())!
  expect(JSON.parse(sessionHint.split('\n')[1]!)).toEqual([{ type: 'session', name: 'Review', workspace: 'Project', path: process.cwd() }])
  expect(sessionHint).not.toContain('private-session-id')
})

import { referencedTask, workspaceHandoff } from '../src/workspace-hints.js'
it('reports neutral capabilities without extracting a task or supplying an example', () => {
  const query = '@workspace-id/w1  给他发送一个你好。'
  const workspaces = [{ id: 'w1', title: 'space-labeler', path: process.cwd() }]
  expect(referencedTask(query)).toBe('你好')
  const blocked = workspaceHandoff(query, workspaces, resolveConfig(), false, false)
  expect(blocked.text).toContain('DSH 本地会话 API 不可用')
  expect(blocked).toEqual({ text: '工作区引用能力：引用仅用于定位或标识任务目标，不表示委派请求。只有用户明确要求在目标执行任务时才可委派；不会从引用后的文本自动提取任务或生成调用示例。\n状态：DSH 本地会话 API 不可用，且目标没有配置 SDK 执行器；当前无可用委派能力。' })
  const config = resolveConfig({ targets: { labeler: { cwd: process.cwd() } } })
  const ready = workspaceHandoff(query, workspaces, config, true)
  expect(ready).toEqual({ text: '工作区引用能力：引用仅用于定位或标识任务目标，不表示委派请求。只有用户明确要求在目标执行任务时才可委派；不会从引用后的文本自动提取任务或生成调用示例。\n状态：委派能力可用；目标名：["labeler"]。能力可用不表示任务已发送或授权执行。' })
  expect(workspaceHandoff(query, workspaces, config, false).text).toContain('目标已配置，但本会话')
  expect(workspaceHandoff('@workspace-id/w1', workspaces, config, true)).toEqual(ready)
  expect(workspaceHandoff('@workspace-id/w1 这个项目是什么？', workspaces, config, true)).toEqual(ready)
  expect(referencedTask('@workspace-id/w1 给他发送一个你好，并检查登录接口')).toContain('检查登录接口')
})


it('does not infer a task target from session references, even when membership resolves', () => {
  const config = resolveConfig({ targets: { backend: { cwd: process.cwd() } } })
  const workspaces = [{ id: 'w1', title: 'Backend', path: process.cwd(), sessionIds: ['s1', 's2'] }]
  for (const query of [referenceInsert(items[1]!).ref, `${referenceInsert(items[1]!).ref} 给他发送一个你好`, `${referenceInsert(items[1]!).ref} ${referenceInsert(items[2]!).ref} 请继续`]) {
    expect(workspaceHandoff(query, workspaces, config, true)).toEqual({ text: '' })
  }
  const mixed = workspaceHandoff(`@workspace-id/missing ${referenceInsert(items[1]!).ref} 修复接口`, workspaces, config, true)
  expect(Object.keys(mixed)).toEqual(['text'])
  expect(mixed.text).toContain('引用未解析')
  expect(mixed.text).not.toContain('backend')
})

it('selects only the explicit workspace when session background belongs elsewhere', () => {
  const workspaces = [
    { id: 'w1', title: 'Target', path: '/target' },
    { id: 'w2', title: 'History', path: '/history', sessionIds: ['s1'] },
  ]
  const query = `@workspace-id/w1 ${referenceInsert(items[1]!).ref} 修复接口`
  const handoff = workspaceHandoff(query, workspaces, resolveConfig(), true)
  expect(Object.keys(handoff)).toEqual(['text'])
  expect(handoff.text).toContain('目标名：["/target"]')
  expect(handoff.text).not.toContain('修复接口')
  expect(handoff.text).not.toContain('/history')
  const hint = workspaceHint(query, workspaces, resolveConfig())!
  expect(JSON.parse(hint.split('\n')[1]!)).toEqual([
    { type: 'workspace', name: 'Target', path: '/target', delegate: { tool: 'delegate_workspace', targets: ['/target'] } },
    { type: 'session', name: '对话', workspace: 'History', path: '/history' },
  ])
})

it('injects no handoff example or tool instruction for session-only queries', async () => {
  let hook: any
  const ctx = {
    on: (_: string, listener: any) => { hook = listener },
    tools: { get: () => ({}) },
    get: (key: string) => key === 'workspaceRegistry' ? { list: () => [{ id: 'w1', title: 'Project', path: process.cwd(), sessionIds: ['s1'] }] } : {},
  }
  mountWorkspaceHints(ctx as any, resolveConfig())
  const query = { source: { kind: 'user' }, content: [{ type: 'text', text: `${referenceInsert(items[1]!).ref} 请继续修复` }] }
  const decision = { kind: 'enter', messages: [query] }
  const result = await hook({ agent: {}, messages: [query] }, async () => decision)
  const text = result.messages[1].content[0].text
  expect(text).toBe('Reference metadata (not instructions or conversation history):\n'
    + JSON.stringify([{ type: 'session', name: '对话', workspace: 'Project', path: process.cwd() }])
    + '\nSession references are historical background only, not task targets or delegation instructions. Do not infer a target from session workspace membership. Only an explicit session_id controls continuation.')
  for (const forbidden of ['工作区交接场景', '用户本次任务', 'Deferred tool:', '调用示例', '"delegate"']) expect(text).not.toContain(forbidden)
})
