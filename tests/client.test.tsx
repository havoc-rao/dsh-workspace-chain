// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { DelegationRow, type DelegationRowProps } from '../src/client/DelegationRow.js'
import { DelegationKind } from '../src/client/DelegationKind.js'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JobsSnapshot, JobView } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { delegationZh, delegationEn, type DelegationTranslate } from '../src/client/delegation-locales.js'
const translator = (dictionary: typeof delegationEn): DelegationTranslate => (key, params) => {
  let text = key in dictionary ? dictionary[key as keyof typeof dictionary] : key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
function jobsSource(initial: JobsSnapshot = { rows: {}, observed: {} }) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    set(next: JobsSnapshot) { snapshot = next; for (const listener of listeners) listener() },
    useDelegationJobs<T>(select: (state: JobsSnapshot) => T): T {
      return select(useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => snapshot))
    },
  }
}
const mounted: { root: Root; element: HTMLElement }[] = []
afterEach(() => { for (const { root, element } of mounted.splice(0)) { act(() => root.unmount()); element.remove() } })
function render(props: unknown, overrides: Partial<Pick<DelegationRowProps, 't' | 'inspect'>> = {}) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const source = jobsSource()
  const openSession = vi.fn()
  const release = vi.fn()
  const watchRows = vi.fn(() => release)
  const fullProps = { ...props as ToolCallViewProps, sessionId: 'owner' as SessionId, useDelegationJobs: source.useDelegationJobs,
    openSession, watchRows, t: translator(delegationZh), ...overrides }
  act(() => root.render(<DelegationRow {...fullProps} />))
  return { element, root, source, openSession, watchRows, release }
}
it('localizes the independently contributed workspace-chain job kind', () => {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  const owner = { job: job('running') } as PropsRuntime<'conversation.session.jobs.kind'>
  for (const [dictionary, expected] of [[delegationZh, '工作区委派'], [delegationEn, 'Workspace delegation']] as const) {
    act(() => root.render(<DelegationKind {...owner} t={translator(dictionary)} />))
    expect(element.textContent).toBe(expected)
  }
})
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
it('never navigates or labels a preallocated background id as confirmed; foreground continuation can open', () => {
  const background = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'bg', call: { name: 'delegate_workspace', argsRaw: '{"target":"backend","task":"x"}' }, content: [], isError: false, meta: { jobId: 'job-1', sessionId: 'session-planned-1' } } })
  expect(background.element.textContent).not.toContain('session-planned-1')
  expect(background.element.querySelector('button')).toBeNull()
  expect(background.watchRows).toHaveBeenCalledExactlyOnceWith('owner')
  const continued = render({ phase: 'result' as const, block: { kind: 'tool-result', callId: 'cont', call: { name: 'delegate_workspace', argsRaw: '{"target":"backend","task":"y","session_id":"session-retained-2"}' }, content: [{ type: 'text', text: 'done' }], isError: false, meta: { sessionId: 'session-retained-2' } } })
  expect(continued.element.textContent).toContain('返回会话 session-retained-2')
  expect(continued.element.querySelector('.chain-record')?.textContent).not.toContain('目标会话')
  act(() => continued.element.querySelector('button')!.click())
  expect(continued.openSession).toHaveBeenCalledExactlyOnceWith('session-retained-2')
})
const result = (meta: Record<string, unknown>, isError = false, argsRaw = '{"target":"backend"}') => ({
  phase: 'result', block: { kind: 'tool-result', callId: 'navigation', call: { name: 'delegate_workspace', argsRaw },
    content: [], isError, meta },
})
function job(status: JobView['status'], sessionId?: string): JobView {
  return { id: 'job-1' as JobId, kind: 'workspace-chain', label: 'Delegation', status,
    startedAt: 1, output: { total: 0, earliest: 0 }, ...(sessionId ? { sessionId: sessionId as SessionId } : {}) }
}
it('reactively opens only the matching owner roster confirmed id and retains navigation after settlement', () => {
  const view = render(result({ jobId: 'job-1', sessionId: 'preallocated' }))
  act(() => view.source.set({ rows: { other: [job('running', 'wrong-owner')], owner: [{ ...job('running', 'wrong-job'), id: 'job-2' as JobId }] }, observed: {} }))
  expect(view.element.querySelector('button')).toBeNull()
  act(() => view.source.set({ rows: { owner: [job('running', 'confirmed')] }, observed: {} }))
  act(() => view.element.querySelector('button')!.click())
  expect(view.openSession).toHaveBeenCalledExactlyOnceWith('confirmed')
  for (const status of ['completed', 'failed', 'killed'] as const) {
    act(() => view.source.set({ rows: { owner: [job(status, 'confirmed')] }, observed: {} }))
    expect(view.element.querySelector('button')?.textContent).toBe('打开目标会话')
    expect(view.element.textContent).not.toContain(delegationZh.backgroundHint)
  }
  act(() => view.root.unmount())
  mounted.splice(mounted.findIndex(entry => entry.root === view.root), 1); view.element.remove()
  expect(view.release).toHaveBeenCalledOnce()
})
it('requires explicit presentation confirmation for failures, never uses args or output and keeps inspect separate', () => {
  const inspect = vi.fn()
  const failed = render(result({ sessionId: 'planned' }, true, '{"target":"backend","session_id":"untrusted"}'), { inspect })
  expect(failed.element.querySelectorAll('button')).toHaveLength(1)
  act(() => failed.element.querySelector('button')!.click())
  expect(inspect).toHaveBeenCalledOnce()
  expect(failed.openSession).not.toHaveBeenCalled()
  const confirmed = render(result({ sessionId: 'retained', sessionConfirmed: true }, true), { inspect })
  act(() => confirmed.element.querySelector('button')!.click())
  expect(confirmed.openSession).toHaveBeenCalledExactlyOnceWith('retained')
  expect(inspect).toHaveBeenCalledOnce()
  expect(render(result({ runId: 'sdk-run' })).element.querySelector('button')).toBeNull()
  expect(render(result({ sessionId: 'sdk-id', sessionConfirmed: true, mode: 'sdk' }, true)).element.querySelector('button')).toBeNull()
  expect(render(result({ sessionId: '   ' })).element.querySelector('button')).toBeNull()
})
it('localizes every card label in English and renders task, identity and output as safe text', () => {
  const malicious = '<img src=x onerror=bad()>'
  const view = render(result({ sessionId: malicious, delegationId: malicious, checkpointPath: malicious }, false,
    JSON.stringify({ target: '/projects/English', task: malicious })), { t: translator(delegationEn), inspect: vi.fn() })
  expect(view.element.querySelector('section')?.getAttribute('aria-label')).toBe('Workspace delegation: English')
  expect(view.element.textContent).toContain('Open target session')
  expect(view.element.textContent).toContain('Delegated task')
  expect(view.element.textContent).toContain('Result returned')
  expect(view.element.textContent).toContain('Delegation record')
  expect(view.element.querySelector('[aria-label="Inspect delegation call"]')).not.toBeNull()
  expect(view.element.querySelector('img')).toBeNull()
  act(() => view.element.querySelector('button')!.click())
  expect(view.openSession).toHaveBeenCalledExactlyOnceWith(malicious)
})

import { vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ ReferenceIconRegular: () => <svg /> }))
import { ReferenceDock } from '../src/client/ReferenceDock.js'
import { referenceEn, referenceZh, type ReferenceTranslate } from '../src/client/reference-locales.js'
const referenceT = ((key: keyof typeof referenceZh) => key === 'references' ? referenceEn[key] : referenceZh[key]) as ReferenceTranslate
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
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} sessionId="current" t={referenceT} />)
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [REFERENCE_MIME], getData: (type: string) => type === REFERENCE_MIME ? JSON.stringify({ version: 1, kind: 'session', id: 's1' }) : '' } })
  act(() => element.querySelector('[aria-label="Session and workspace references"]')!.dispatchEvent(event))
  expect(insert).toHaveBeenCalledExactlyOnceWith(refs[1])
  expect(element.querySelector('[role="status"]')?.textContent).toContain(referenceZh.blockedDrop)
})
it('shows a body portal reference overlay, leaves image drops and tree sorting alone, and cleans up', () => {
  const insert = vi.fn(() => true)
  const { element } = mountUi(<ReferenceDock items={() => refs} insert={insert} sessionId="current" t={referenceT} />)
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
  expect(document.querySelector('[data-workspace-chain-reference-overlay]')?.textContent).toBe(referenceZh.dropHint + referenceZh.dropDescription)
  expect(document.querySelector('[data-workspace-chain-reference-overlay]')?.parentElement).toBe(document.body)
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