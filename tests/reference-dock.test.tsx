// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ ReferenceIconRegular: ({ kind }: { kind: string }) => <svg data-reference-kind={kind} /> }))
import { ReferenceDock } from '../src/client/ReferenceDock.js'
import { insertInputReference, type ReferenceInputActions } from '../src/client/reference-insertion.js'
import { referenceEn, type ReferenceTranslate } from '../src/client/reference-locales.js'
import { REFERENCE_MIME, referenceInsert, resolveDrop, workspaceReferenceIds, type ReferenceItem } from '../src/shared/references.js'
const item: ReferenceItem = { kind: 'workspace', id: 'w1', label: 'Project', description: '/project' }
const t = ((key: keyof typeof referenceEn) => referenceEn[key]) as ReferenceTranslate
function transfer(id = 'w1', files = false) {
  return { types: files ? [REFERENCE_MIME, 'Files'] : [REFERENCE_MIME], getData: (type: string) => type === REFERENCE_MIME ? JSON.stringify({ version: 1, kind: 'workspace', id }) : 'raw machine text', dropEffect: 'none' }
}
function drop(target: Element, data = transfer()) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  act(() => { target.dispatchEvent(event) })
  return event
}
function fixture(disabled = false, insert = vi.fn(() => true)) {
  const host = document.createElement('div'); host.setAttribute('data-conversation-session', 's1'); document.body.append(host)
  host.innerHTML = '<div data-conversation-region="chat"></div><div data-composer-card><textarea></textarea><div id="dock"></div></div><div role="tree"><div role="treeitem"></div></div>'
  const root = createRoot(host.querySelector('#dock')!)
  act(() => root.render(<ReferenceDock items={() => [item]} insert={insert} disabled={disabled} sessionId="s1" t={t} />))
  return { host, insert, clean: () => { act(() => root.unmount()); host.remove() } }
}
it('claims in capture exactly once before document and target listeners', () => {
  const f = fixture(); const duplicate = vi.fn()
  document.addEventListener('drop', duplicate, true)
  window.addEventListener('drop', duplicate, true)
  try {
    const event = drop(f.host.querySelector('textarea')!)
    expect(event.defaultPrevented).toBe(true); expect(f.insert).toHaveBeenCalledTimes(1); expect(duplicate).not.toHaveBeenCalled()
    drop(f.host.querySelector('[data-conversation-region="chat"]')!)
    expect(f.insert).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[style*="position: fixed"]')).toBeNull()
  } finally { document.removeEventListener('drop', duplicate, true); window.removeEventListener('drop', duplicate, true); f.clean() }
})
it('leaves tree reordering and Files untouched while accepting outside conversation', () => {
  const f = fixture(); const outside = document.createElement('div'); document.body.append(outside)
  try {
    expect(drop(f.host.querySelector('[role="treeitem"]')!).defaultPrevented).toBe(false)
    expect(drop(f.host.querySelector('textarea')!, transfer('w1', true)).defaultPrevented).toBe(false)
    expect(drop(outside).defaultPrevented).toBe(true); expect(f.insert).toHaveBeenCalledTimes(1)
  } finally { outside.remove(); f.clean() }
})
it('claims busy and unknown references without insertion or raw-text fallback', () => {
  const f = fixture(true); const native = vi.fn(); document.addEventListener('drop', native)
  try {
    expect(drop(f.host.querySelector('textarea')!).defaultPrevented).toBe(true)
    expect(f.host.textContent).toContain(referenceEn.blockedDrop)
    const style = f.host.querySelector('[role="status"]')!.getAttribute('style')!
    expect(style).toContain('var(--dsw-alias-bg-base)')
    expect(style).toContain('var(--dsw-elevation-soft)')
    expect(style).not.toMatch(/Canvas|#0002/u)
    expect(drop(f.host.querySelector('textarea')!, transfer('unknown')).defaultPrevented).toBe(true)
    expect(f.host.textContent).toContain(referenceEn.invalidDrop)
    expect(f.insert).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled()
  } finally { document.removeEventListener('drop', native); f.clean() }
})
it('shows a localized refusal when host insertion rejects', () => {
  const f = fixture(false, vi.fn(() => false))
  try { drop(f.host.querySelector('textarea')!); expect(f.host.textContent).toContain(referenceEn.blockedDrop) } finally { f.clean() }
})
it('captures fresh detect spans for consecutive chips rather than clipboard length', () => {
  let offset = 1; let rev = 4
  const calls: string[] = []
  const focus = vi.fn(() => { calls.push('focus') })
  const actions = { focus, captureInsertion: vi.fn(() => { calls.push('capture'); return { start: offset, end: offset, draftRev: rev } }), insertReference: vi.fn((_reference, span) => {
    calls.push('insert')
    expect(span).toEqual({ start: offset, end: offset, draftRev: rev }); offset++; rev++; return true
  }) }
  expect(insertInputReference(actions, item)).toBe(true); expect(insertInputReference(actions, item)).toBe(true)
  expect(actions.insertReference.mock.calls.map(call => call[1])).toEqual([{ start: 1, end: 1, draftRev: 4 }, { start: 2, end: 2, draftRev: 5 }])
  expect(focus).toHaveBeenCalledTimes(2)
  expect(calls).toEqual(['capture', 'insert', 'focus', 'capture', 'insert', 'focus'])
  expect(insertInputReference({ captureInsertion: actions.captureInsertion } as unknown as ReferenceInputActions, item)).toBe(false)
  expect(focus).toHaveBeenCalledTimes(2)
})
it('focuses synchronously after successful workspace/session inserts but not rejected ones', () => {
  for (const kind of ['workspace', 'session'] as const) {
    const order: string[] = []
    const actions = { captureInsertion: vi.fn(() => ({ start: 1, end: 1, draftRev: 2 })), insertReference: vi.fn(() => { order.push('insert'); return true }), focus: vi.fn(() => { order.push('focus') }) }
    expect(insertInputReference(actions, { ...item, kind })).toBe(true)
    expect(order).toEqual(['insert', 'focus'])
    actions.insertReference.mockImplementation(() => { order.push('reject'); return false })
    expect(insertInputReference(actions, { ...item, kind })).toBe(false)
    expect(order).toEqual(['insert', 'focus', 'reject']); expect(actions.focus).toHaveBeenCalledTimes(1)
  }
})
it('does not focus locked, invalid, tree or Files drops', () => {
  const actions = { captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 0 })), insertReference: vi.fn(() => true), focus: vi.fn() }
  const insert = vi.fn(() => insertInputReference(actions, item))
  const locked = fixture(true, insert)
  try { drop(locked.host.querySelector('textarea')!); expect(actions.focus).not.toHaveBeenCalled() } finally { locked.clean() }
  const ready = fixture(false, insert)
  try {
    drop(ready.host.querySelector('textarea')!, transfer('unknown'))
    drop(ready.host.querySelector('[role="treeitem"]')!)
    drop(ready.host.querySelector('textarea')!, transfer('w1', true))
    expect(actions.insertReference).not.toHaveBeenCalled(); expect(actions.focus).not.toHaveBeenCalled()
    drop(ready.host.querySelector('textarea')!)
    expect(actions.insertReference).toHaveBeenCalledTimes(1); expect(actions.focus).toHaveBeenCalledTimes(1)
  } finally { ready.clean() }
})
it('resolves same-name workspaces by id and never guesses paths for unknown ids', () => {
  const second = { ...item, id: 'w2', description: '/other' }
  expect(resolveDrop(transfer('w2'), [item, second])).toBe(second)
  expect(resolveDrop(transfer('/project'), [item, second])).toBeUndefined()
  expect(resolveDrop(transfer('missing'), [item, second])).toBeUndefined()
})
it('workspace insertion is session-free and retains explicit workspace identity', () => {
  const result = referenceInsert(item)
  expect(workspaceReferenceIds(result.ref)).toEqual(['w1']); expect(JSON.stringify(result)).not.toContain('dsh-session')
})
