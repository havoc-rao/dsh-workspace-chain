// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DelegationRow } from '../src/client/DelegationRow.js'
const mounted: { root: Root; element: HTMLElement }[] = []
afterEach(() => { for (const { root, element } of mounted.splice(0)) { act(() => root.unmount()); element.remove() } })
function render(props: unknown) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  act(() => root.render(<DelegationRow {...props as ToolCallViewProps} />))
  return { element }
}
it('renders preparing calls from the host streaming argument view without the removed hook', () => {
  const args = new PartialArguments()
  args.append('{"target":"/projects/backend","task":"检查')
  const { element } = render({ phase: 'preparing', block: { args } })
  expect(element.textContent).toContain('backend')
  expect(element.textContent).toContain('检查')
  expect(element.textContent).toContain('正在委派')
})
const runningProps = { phase: 'start' as const, block: { phase: 'start', callId: 'one', argsRaw: '{"target":"backend"}' } }
it('shows running and failed states without rendering model output as HTML', () => {
  const running = render(runningProps)
  expect(running.element.textContent).toContain('正在委派')
  const failed = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'two', call: { name: 'delegate_workspace', argsRaw: '{"target":"docs"}' }, isError: true, content: [{ type: 'text', text: '<script>bad()</script>' }] } })
  expect(failed.element.textContent).toContain('委派失败')
  expect(failed.element.querySelector('script')).toBeNull()
  expect(failed.element.querySelector('details')?.open).toBe(true)
})
it('keeps background admission distinct from a completed result', () => {
  const background = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'three', call: null, content: [], isError: false, meta: { jobId: 'job-1' } } })
  expect(background.element.textContent).toContain('后台已启动')
  expect(background.element.textContent).not.toContain('已返回结果')
  expect(background.element.querySelector('button')).toBeNull()
})
it('shows the preallocated session id on background rows and a return-to-session marker for session_id calls', () => {
  const background = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'bg', call: { name: 'delegate_workspace', argsRaw: '{"target":"backend","task":"x"}' }, content: [], isError: false, meta: { jobId: 'job-1', sessionId: 'session-planned-1' } } })
  expect(background.element.textContent).toContain('目标会话 session-planned-1')
  const continued = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'cont', call: { name: 'delegate_workspace', argsRaw: '{"target":"backend","task":"y","session_id":"session-retained-2"}' }, content: [{ type: 'text', text: 'done' }], isError: false, meta: { sessionId: 'session-retained-2' } } })
  expect(continued.element.textContent).toContain('返回会话 session-retained-2')
  expect(continued.element.textContent).not.toContain('目标会话')
})

import { vi } from 'vitest'
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
it('drops a known session once and reports rejected insertion without sending anything', () => {
  const insert = vi.fn(() => false)
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} />)
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [REFERENCE_MIME], getData: (type: string) => type === REFERENCE_MIME ? JSON.stringify({ version: 1, kind: 'session', id: 's1' }) : '' } })
  act(() => element.querySelector('[aria-label="Session and workspace references"]')!.dispatchEvent(event))
  expect(insert).toHaveBeenCalledExactlyOnceWith(refs[1])
  expect(element.querySelector('[role="status"]')?.textContent).toContain('暂时无法插入')
})
it('shows a full-page reference mask, leaves image drops and tree sorting alone, and cleans up', () => {
  const insert = vi.fn(() => true)
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} />)
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