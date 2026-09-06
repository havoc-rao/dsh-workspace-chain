// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { workspaceReference, workspaceReferenceIds, workspaceMentions, referenceInsert } from '../src/shared/references.js'
import { referencedTask } from '../src/workspace-hints.js'
import { createWorkspaceSource } from '../src/client/source.js'
import { selectWorkspaceReference, WorkspaceMessageReference } from '../src/client/WorkspaceMessageReference.js'

it('persists a Unicode display label separately from workspace identity and extracts the task', async () => {
  const label = '项目 / "测试" 🙂'
  const ref = referenceInsert({ kind: 'workspace', id: 'stable-id', label, description: '' }).ref
  expect(workspaceMentions(ref)).toEqual([{ ref, id: 'stable-id', label }])
  expect(workspaceReferenceIds(`${ref} @workspace-id/stable-id`)).toEqual(['stable-id'])
  expect(referencedTask(`${ref} 给他发送一个你好。`)).toBe('你好')
  const source = createWorkspaceSource(async () => ({ toolName: 'delegate_workspace', targets: [] }), () => [{ kind: 'workspace', id: 'stable-id', label, description: '' }])
  expect(await source.codec!.serialize('@workspace-id/stable-id', new AbortController().signal)).toBe(ref)
  expect(await source.codec!.serialize(ref, new AbortController().signal)).toBe(ref)
  expect(source.codec!.clipboardText(ref)).toBe(ref)
  expect(selectWorkspaceReference({ token: '@some-file/path' })).toBeNull()
  expect(selectWorkspaceReference({ token: '@workspace-ref/invalid' })).toBeNull()
})

it('renders old IDs using the current workspace name and new references using their saved name after removal', () => {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  const paint = (token: string, items: unknown[]) => {
    const matched = selectWorkspaceReference({ token })!
    act(() => root.render(<WorkspaceMessageReference {...{ matched, useWorkspaces: (select: (state: unknown) => unknown) => select({ items }) } as unknown as ComponentProps<typeof WorkspaceMessageReference>} />))
  }
  try {
    paint('@workspace-id/stable-id', [{ workspaceId: 'stable-id', title: '当前名称', path: '/project' }])
    expect(element.textContent).toBe('当前名称')
    expect(element.firstElementChild?.getAttribute('title')).toContain('/project')
    paint(workspaceReference('stable-id', '保存的名称'), [])
    expect(element.textContent).toBe('保存的名称')
    paint('@workspace-id/stable-id', [])
    expect(element.textContent).toBe('工作区不可用')
    expect(element.textContent).not.toContain('stable-id')
  } finally { act(() => root.unmount()); element.remove() }
})
