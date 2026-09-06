// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { DelegationRow } from '../src/client/DelegationRow.js'
import { createWorkspaceSource } from '../src/client/source.js'
const mounted: { root: Root; element: HTMLElement }[] = []
afterEach(() => { for (const { root, element } of mounted.splice(0)) { act(() => root.unmount()); element.remove() } })
function render(block: unknown) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  act(() => root.render(<DelegationRow {...{ block } as unknown as ToolCallViewProps} />))
  return { element }
}
it('shows workspace candidates and inserts a serializable reference chip', async () => {
  const source = createWorkspaceSource(async () => ({ toolName: 'delegate_workspace', targets: [{ name: 'b', purpose: 'backend', aliases: ['api'] }] }))
  const candidates = await source.candidates({ sessionId: 'a' as never }, { query: 'api', signal: new AbortController().signal, position: 'inline' })
  expect(candidates).toHaveLength(1)
  const pick = source.onPick({ candidate: candidates[0]!, session: { sessionId: 'a' as never }, position: 'inline', via: 'menu', span: { start: 0, end: 2, draftRev: 1 } })
  expect(pick).toMatchObject({ insert: { ref: '@workspace/b', label: 'b', appearance: 'folder' } })
  expect(await source.codec!.serialize('@workspace/b', new AbortController().signal)).toBe('@workspace/b')
})
it('shows running and failed states without rendering model output as HTML', () => {
  const running = render({ callId: 'one', argsRaw: '{"target":"backend"}' })
  expect(running.element.textContent).toContain('正在委派')
  const failed = render({ kind: 'tool-result', callId: 'two', call: { argsRaw: '{"target":"docs"}' }, isError: true, content: [{ type: 'text', text: '<script>bad()</script>' }] })
  expect(failed.element.textContent).toContain('委派失败')
  expect(failed.element.querySelector('script')).toBeNull()
  expect(failed.element.querySelector('details')?.open).toBe(true)
})
it('keeps background admission distinct from a completed result', () => {
  const background = render({ kind: 'tool-result', callId: 'three', call: null, content: [], isError: false, meta: { jobId: 'job-1' } })
  expect(background.element.textContent).toContain('后台已启动')
  expect(background.element.textContent).not.toContain('已返回结果')
  expect(background.element.querySelector('button')).toBeNull()
})

import { vi } from 'vitest'
import { ReferenceMenu, type ReferenceMenuProps } from '../src/client/ReferenceMenu.js'
import { ReferenceDock } from '../src/client/ReferenceDock.js'
import { REFERENCE_MIME, type ReferenceItem } from '../src/shared/references.js'
const refs: ReferenceItem[] = [
  { kind: 'workspace', id: 'w1', label: '本地项目', description: '/local' },
  { kind: 'session', id: 's1', label: '原会话', description: '/local', workspaceId: 'w1' },
  { kind: 'session', id: 's2', label: '分支会话', description: '/local', workspaceId: 'w1', parentId: 's1' },
]
function mountUi(node: React.ReactNode) {
  const element = document.createElement('div'); element.setAttribute('data-composer-card', ''); document.body.append(element)
  const textarea = document.createElement('textarea'); element.append(textarea)
  const host = document.createElement('div'); element.append(host)
  const root = createRoot(host); mounted.push({ root, element }); act(() => root.render(node))
  return { element, textarea }
}
it('browses project → session → fork and keyboard picks only a visible leaf', async () => {
  const source = createWorkspaceSource(async () => ({ toolName: 'delegate_workspace', targets: [] }), () => refs)
  const candidates = await source.candidates({ sessionId: 's1' as never }, { query: '', signal: new AbortController().signal, position: 'inline' })
  const state = { open: true, hit: { trigger: '@', query: '', quoted: false, position: 'inline', span: { start: 0, end: 1, draftRev: 1 } }, generation: 1, highlight: null, groups: [{ source: 'workspace-chain', status: 'ready', items: candidates }] } as const
  const pick = vi.fn()
  const menu = { getSnapshot: () => state, subscribe: () => () => {} } as unknown as ReferenceMenuProps['menu']
  const { element, textarea } = mountUi(<ReferenceMenu menu={menu} onPick={pick} onDismiss={() => {}} references={() => refs} currentWorkspace={() => 'w1'} />)
  const choose = (label: string) => {
    const row = [...element.querySelectorAll('[role="option"]')].find(row => row.textContent?.includes(label))!
    expect(row).toBeDefined(); act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  }
  expect(element.textContent).not.toContain('原会话')
  choose('workspace'); choose('本地项目'); expect(element.textContent).toContain('引用 workspace 本身')
  choose('原会话'); choose('fork · 分支会话')
  act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(pick).toHaveBeenCalledWith('workspace-chain', 2)
})
it('keeps foreign-source candidates selectable and displays category paths in list mode', () => {
  const state = { open: true, hit: { trigger: '@', query: '' }, generation: 1, highlight: null, groups: [{ source: 'file', status: 'ready', items: [{ name: 'README.md' }] }] } as never
  const pick = vi.fn()
  const menu = { getSnapshot: () => state, subscribe: () => () => {} } as unknown as ReferenceMenuProps['menu']
  const { element } = mountUi(<ReferenceMenu menu={menu} onPick={pick} onDismiss={() => {}} references={() => []} currentWorkspace={() => undefined} />)
  expect(element.textContent).not.toContain('README.md')
  const list = [...element.querySelectorAll('button')].find(button => button.textContent === '分类列表')!
  act(() => list.click())
  expect(element.querySelector('[role="presentation"]')?.textContent).toBe('文件')
  const row = [...element.querySelectorAll('[role="option"]')].find(row => row.textContent?.includes('README.md'))!
  act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  expect(pick).toHaveBeenCalledWith('file', 0)
})
it('drops a known session once and reports rejected insertion without sending anything', () => {
  const insert = vi.fn(() => false)
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} />)
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [REFERENCE_MIME], getData: (type: string) => type === REFERENCE_MIME ? JSON.stringify({ version: 1, kind: 'session', id: 's1' }) : '' } })
  act(() => element.querySelector('[aria-label="Session and workspace references"]')!.dispatchEvent(event))
  expect(insert).toHaveBeenCalledExactlyOnceWith(refs[1])
  expect(element.querySelector('[role="status"]')?.textContent).toContain('暂时无法插入')
})
it('keeps search inside the selected session when that scope has no matches', async () => {
  const source = createWorkspaceSource(async () => ({ toolName: 'delegate_workspace', targets: [] }), () => refs)
  const candidates = await source.candidates({ sessionId: 's1' as never }, { query: '', signal: new AbortController().signal, position: 'inline' })
  type State = ReturnType<ReferenceMenuProps['menu']['getSnapshot']>
  let state: State = { open: true, hit: { trigger: '@', query: '', quoted: false, position: 'inline', span: { start: 0, end: 1, draftRev: 1 } }, generation: 1, highlight: null, groups: [{ source: 'workspace-chain', status: 'ready', items: candidates }, { source: 'file', status: 'ready', items: [{ name: 'foreign.md' }] }] }
  const listeners = new Set<() => void>()
  const menu = { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } } as unknown as ReferenceMenuProps['menu']
  const { element } = mountUi(<ReferenceMenu menu={menu} onPick={() => {}} onDismiss={() => {}} references={() => refs} currentWorkspace={() => 'w1'} />)
  for (const label of ['workspace', '本地项目', '原会话']) {
    const row = [...element.querySelectorAll('[role="option"]')].find(row => row.textContent?.includes(label))!
    act(() => row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
  }
  act(() => {
    state = { ...state, hit: { ...state.hit!, query: 'foreign' }, groups: [{ source: 'workspace-chain', status: 'ready', items: [] }, state.groups[1]!] }
    listeners.forEach(fn => fn())
  })
  expect(element.textContent).toContain('当前来源没有匹配项')
  expect(element.textContent).not.toContain('foreign.md')
  expect(element.querySelectorAll('[role="option"]')).toHaveLength(0)
})
it('shows a full-page reference mask, leaves image drops and tree sorting alone, and cleans up', () => {
  const insert = vi.fn(() => true)
  const open = vi.fn()
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} open={open} />)
  expect(element.textContent).toBe('@')
  act(() => element.querySelector('button')!.click())
  expect(open).toHaveBeenCalledOnce()
  const drag = (type: string, types: string[], target: Element = element) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'none', getData: () => JSON.stringify({ version: 1, kind: 'session', id: 's1' }) } })
    act(() => target.dispatchEvent(event))
    return event
  }
  expect(drag('dragenter', ['Files']).defaultPrevented).toBe(false)
  expect(document.querySelector('[aria-label="引用拖放"]')).toBeNull()
  expect(drag('drop', ['Files', REFERENCE_MIME]).defaultPrevented).toBe(false)
  expect(insert).not.toHaveBeenCalled()
  drag('dragenter', [REFERENCE_MIME])
  expect(document.querySelector('[aria-label="引用拖放"]')?.parentElement).toBe(document.body)
  const tree = document.createElement('div'); tree.setAttribute('role', 'treeitem'); element.append(tree)
  expect(drag('dragover', [REFERENCE_MIME], tree).defaultPrevented).toBe(false)
  expect(drag('drop', [REFERENCE_MIME], tree).defaultPrevented).toBe(false)
  expect(insert).not.toHaveBeenCalled()
  drag('dragenter', [REFERENCE_MIME]); drag('drop', [REFERENCE_MIME])
  expect(insert).toHaveBeenCalledExactlyOnceWith(refs[1])
  expect(document.querySelector('[aria-label="引用拖放"]')).toBeNull()
  const entry = mounted.find(entry => entry.element === element)!
  act(() => entry.root.unmount())
  expect(drag('drop', [REFERENCE_MIME]).defaultPrevented).toBe(false)
})

import { ReferencePreview, previewReference } from '../src/client/ReferencePreview.js'
import { referenceInsert } from '../src/shared/references.js'
it('previews the exact hovered occurrence through the textarea and exposes original fork metadata', async () => {
  vi.useFakeTimers()
  try {
    const fork = { ...refs[2]!, label: '同名会话', updatedAt: 1000 }
    const all = [refs[0]!, { ...refs[1]!, label: '同名会话' }, fork]
    expect(previewReference(referenceInsert(fork).ref, all)?.id).toBe('s2')
    const { element, textarea } = mountUi(<ReferencePreview occurrences={[{ occurrenceId: 9, source: 'workspace-chain', ref: referenceInsert(fork).ref, label: fork.label }]} items={() => all}
      load={async () => ({ toolName: 'delegate_workspace', targets: [], workspaces: [{ id: 'w1', targets: ['backend'] }] })} />)
    const chip = document.createElement('span'); chip.dataset.decoration = 'chip'; chip.dataset.occurrence = '9'; element.append(chip)
    const rect = { left: 10, right: 100, top: 100, bottom: 120 } as DOMRect
    chip.getClientRects = () => [rect] as unknown as DOMRectList
    chip.getBoundingClientRect = () => rect
    await act(async () => {
      textarea.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 110 }))
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Fork session')
    expect(tooltip.textContent).not.toContain('ID：')
    expect(tooltip.textContent).toContain('来源会话：同名会话')
    expect(tooltip.textContent).toContain('委托配置：backend')
    act(() => textarea.dispatchEvent(new Event('input', { bubbles: true })))
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  } finally { vi.useRealTimers() }
})
