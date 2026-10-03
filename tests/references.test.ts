import { expect, it } from 'vitest'
import { REFERENCE_MIME, referenceInsert, resolveDrop, workspaceReferenceIds, type ReferenceItem } from '../src/shared/references.js'
import { workspaceHint } from '../src/workspace-hints.js'
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
it('aligns a session reference to host membership and the real fresh-session tool contract', () => {
  const config = resolveConfig({ targets: { backend: { cwd: process.cwd() } } })
  const workspaces = [{ id: 'w1', title: 'Backend', path: process.cwd(), sessionIds: ['s1'] }]
  const query = referenceInsert(items[1]!).ref
  const hint = workspaceHint(query, workspaces, config)!
  expect(hint).toContain('"targets":["backend"]')
  expect(hint).toContain('does not resume the reference')
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
  expect(JSON.parse(sessionHint.split('\n')[1]!)).toEqual([{ type: 'session', name: 'Review', workspace: 'Project', path: process.cwd(), delegate: { tool: 'delegate_workspace', targets: [process.cwd()] } }])
  expect(sessionHint).not.toContain('private-session-id')
})

import { referencedTask, workspaceHandoff } from '../src/workspace-hints.js'
it('explains the actual hello handoff and distinguishes missing configuration from missing visibility', () => {
  const query = '@workspace-id/w1  给他发送一个你好。'
  const workspaces = [{ id: 'w1', title: 'space-labeler', path: process.cwd() }]
  expect(referencedTask(query)).toBe('你好')
  const blocked = workspaceHandoff(query, workspaces, resolveConfig(), false, false)
  expect(blocked.text).toContain('DSH 本地会话 API 不可用')
  expect(blocked.text).toContain('不能确认已发送')
  expect(blocked.example).toBeUndefined()
  const config = resolveConfig({ targets: { labeler: { cwd: process.cwd() } } })
  const ready = workspaceHandoff(query, workspaces, config, true)
  expect(ready.example).toEqual({ target: 'labeler', task: '你好' })
  expect(ready.text).toContain('工作区交接场景')
  expect(workspaceHandoff(query, workspaces, config, false).text).toContain('目标已配置，但本会话')
  expect(workspaceHandoff('@workspace-id/w1', workspaces, config, true).example).toBeUndefined()
  expect(referencedTask('@workspace-id/w1 给他发送一个你好，并检查登录接口')).toContain('检查登录接口')
})
