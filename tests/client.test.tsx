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
  expect(running.element.textContent).toContain('Delegating…')
  const failed = render({ kind: 'tool-result', callId: 'two', call: { argsRaw: '{"target":"docs"}' }, isError: true, content: [{ type: 'text', text: '<script>bad()</script>' }] })
  expect(failed.element.textContent).toContain('Delegation failed')
  expect(failed.element.querySelector('script')).toBeNull()
  expect(failed.element.querySelector('details')?.open).toBe(true)
})
it('keeps background admission distinct from a completed result', () => {
  const background = render({ kind: 'tool-result', callId: 'three', call: null, content: [], isError: false, meta: { jobId: 'job-1' } })
  expect(background.element.textContent).toContain('Background job started')
  expect(background.element.textContent).not.toContain('Result received')
  expect(background.element.querySelector('button')).toBeNull()
})
