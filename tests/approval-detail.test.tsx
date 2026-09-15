// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, type Mock, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { OwnerOfResult } from '../src/shared/catalog.js'
import { EscalationDelegation, type EscalationDelegationProps } from '../src/client/EscalationDelegation.js'

const mounted: { root: Root; element: HTMLElement }[] = []
afterEach(() => { for (const { root, element } of mounted.splice(0)) { act(() => root.unmount()); element.remove() } })

function callBlock(call: unknown) {
  return { nodes: { values: () => [{ kind: 'tool-call', data: { root: call } }] } }
}
type OwnerQuery = (path: string, sessionId: string) => Promise<OwnerOfResult>
function render(props: Partial<EscalationDelegationProps> & { call: unknown }) {
  const fallback = vi.fn<OwnerQuery>(async () => { throw new Error('unexpected query') })
  const queryOwner = (props.queryOwner ?? fallback) as unknown as Mock<OwnerQuery>
  const useChat = (selector: (snapshot: object) => unknown) => selector(callBlock(props.call))
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted.push({ root, element })
  act(() => root.render(<EscalationDelegation
    callId="call-1" sessionId={SessionId('session-a')} useChat={useChat as never} queryOwner={queryOwner} />))
  return { element, queryOwner }
}
const ownerResult = (over: Partial<OwnerOfResult> = {}): OwnerOfResult => ({
  path: '/wb/src/x.ts', exists: true,
  current: { kind: 'workspace', id: 'wa', name: 'A', root: '/wa', delegatable: true },
  owners: [{ kind: 'workspace', id: 'wb', name: 'B', root: '/wb', delegatable: true }],
  ...over,
})

it('keeps the shipped command display for shell escalations', () => {
  const { element } = render({ call: { callId: 'call-1', name: 'bash', argsRaw: '{"command":"chmod +x run.sh"}' } })
  expect(element.textContent).toContain('chmod +x run.sh')
  expect(element.textContent).not.toContain('重新查询')
})

it('queries ownership for a blocked edit and raises the delegate-to-workspace tip', async () => {
  const queryOwner = vi.fn(async () => ownerResult())
  const { element } = render({ call: { callId: 'call-1', name: 'edit', argsRaw: '{"file_path":"/wb/src/x.ts"}' }, queryOwner })
  expect(queryOwner).toHaveBeenCalledWith('/wb/src/x.ts', 'session-a')
  await act(async () => { await Promise.resolve() })
  const text = element.textContent!
  expect(text).toContain('/wb/src/x.ts')
  expect(element.textContent).toContain('工作区 "B"')
  expect(element.textContent).toContain('委派给该工作区')
  const copy = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('复制委派指令'))
  expect(copy).toBeDefined()
  act(() => copy!.click())
  await act(async () => { await Promise.resolve() })
  expect(element.textContent).toContain('已复制委派指令')
})

it('reassures when the path belongs to the current workspace', async () => {
  const { element } = render({
    call: { callId: 'call-1', name: 'write', argsRaw: '{"file_path":"/wa/src/x.ts"}' },
    queryOwner: vi.fn(async () => ownerResult({ path: '/wa/src/x.ts', owners: [{ kind: 'workspace', id: 'wa', name: 'A', root: '/wa', delegatable: true }] })),
  })
  await act(async () => { await Promise.resolve() })
  expect(element.textContent).toContain('位于当前工作区')
  expect(element.textContent).not.toContain('复制委派指令')
})

it('reports unmatched paths and recovers from a failed query via re-query', async () => {
  const queryOwner = vi.fn<OwnerQuery>(async () => { throw new Error('rpc down') })
  const { element } = render({ call: { callId: 'call-1', name: 'edit', argsRaw: '{"file_path":"/elsewhere/f.ts"}' }, queryOwner })
  await act(async () => { await Promise.resolve() })
  expect(element.textContent).toContain('查询失败')
  queryOwner.mockResolvedValueOnce(ownerResult({ owners: [] }))
  const retry = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('重新查询'))
  expect(retry).toBeDefined()
  act(() => retry!.click())
  await act(async () => { await Promise.resolve() })
  expect(element.textContent).toContain('未匹配到已登记的工作区')
})

it('stays empty for unknown tools and unlinked call ids', () => {
  const empty = render({ call: { callId: 'call-other', name: 'glob', argsRaw: '{}' } })
  expect(empty.element.textContent).toBe('')
})