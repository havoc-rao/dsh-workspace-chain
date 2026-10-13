// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ ReferenceIconRegular: () => <svg /> }))
import { ReferenceDock } from '../src/client/ReferenceDock.js'
import { REFERENCE_MIME } from '../src/shared/references.js'
import { referenceEn, type ReferenceTranslate } from '../src/client/reference-locales.js'
const t = ((key: keyof typeof referenceEn) => referenceEn[key]) as ReferenceTranslate
const overlay = () => document.querySelector('[data-workspace-chain-reference-overlay]') as HTMLElement | null
function mount(id = 's1', disabled = false) {
  const host = document.createElement('div'); host.dataset.conversationSession = id
  host.innerHTML = '<div data-composer-card><textarea></textarea><div></div></div>'; document.body.append(host)
  const root = createRoot(host.querySelector('[data-composer-card] > div')!); const insert = vi.fn(() => true)
  act(() => root.render(<ReferenceDock sessionId={id} disabled={disabled} items={() => [{ kind: 'workspace', id: 'w1', label: 'P', description: '' }]} insert={insert} t={t} />))
  return { host, insert, clean: () => { act(() => root.unmount()); host.remove() } }
}
function drag(type: string, target: Element = document.body, options: { files?: boolean; related?: EventTarget | null; x?: number; id?: string } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: options.related ?? null, clientX: options.x ?? 10, clientY: 10 })
  Object.defineProperty(event, 'dataTransfer', { value: { types: options.files ? [REFERENCE_MIME, 'Files'] : [REFERENCE_MIME], dropEffect: 'none', getData: () => JSON.stringify({ version: 1, kind: 'workspace', id: options.id ?? 'w1' }) } })
  act(() => target.dispatchEvent(event)); return event
}
it('renders full-screen body portal and outside-conversation release inserts once', () => {
  const f = mount()
  try {
    expect(drag('dragenter').defaultPrevented).toBe(true)
    expect(overlay()?.parentElement).toBe(document.body)
    expect(overlay()?.textContent).toBe(referenceEn.dropHint + referenceEn.dropDescription)
    expect(overlay()?.style.position).toBe('fixed'); expect(overlay()?.style.inset).toBe('0')
    expect(overlay()?.style.pointerEvents).toBe('none'); expect(overlay()?.style.background).toBe('var(--dsw-alias-bg-mask-drop)')
    expect(drag('drop').defaultPrevented).toBe(true); expect(f.insert).toHaveBeenCalledTimes(1); expect(overlay()).toBeNull()
  } finally { f.clean() }
})
it('shows blocked overlay without description and clears on rejected or invalid drop', () => {
  const f = mount('s1', true)
  try {
    drag('dragenter'); expect(overlay()?.textContent).toBe(referenceEn.blockedDrop)
    expect(drag('drop').defaultPrevented).toBe(true); expect(overlay()).toBeNull(); expect(f.insert).not.toHaveBeenCalled()
    drag('dragenter'); drag('drop', document.body, { id: 'unknown' }); expect(overlay()).toBeNull(); expect(f.host.textContent).toContain(referenceEn.invalidDrop)
  } finally { f.clean() }
})
it('balances nested transitions, leaving window, dragend, blur and unmount', () => {
  const f = mount(); const child = f.host.querySelector('textarea')!
  try {
    drag('dragenter'); drag('dragenter', child)
    drag('dragleave', child, { related: f.host }); expect(overlay()).not.toBeNull()
    drag('dragleave', document.body, { x: 0 }); expect(overlay()).toBeNull()
    drag('dragenter'); act(() => window.dispatchEvent(new Event('dragend'))); expect(overlay()).toBeNull()
    drag('dragenter'); act(() => window.dispatchEvent(new Event('blur'))); expect(overlay()).toBeNull()
    drag('dragenter'); f.clean(); expect(overlay()).toBeNull(); expect(drag('drop').defaultPrevented).toBe(false)
  } catch (error) { f.clean(); throw error }
})
it('does not steal tree or Files events and clears reference overlay when entering them', () => {
  const f = mount(); const tree = document.createElement('div'); tree.setAttribute('role', 'tree'); document.body.append(tree)
  try {
    drag('dragenter'); expect(drag('dragover', tree).defaultPrevented).toBe(false); expect(overlay()).toBeNull()
    expect(drag('drop', tree).defaultPrevented).toBe(false)
    drag('dragenter'); expect(drag('dragover', document.body, { files: true }).defaultPrevented).toBe(false); expect(overlay()).toBeNull()
    expect(drag('drop', document.body, { files: true }).defaultPrevented).toBe(false); expect(f.insert).not.toHaveBeenCalled()
  } finally { tree.remove(); f.clean() }
})
it('ignores hidden mounted sessions and refuses ambiguous outside release', () => {
  const hidden = mount('hidden'); hidden.host.hidden = true; const current = mount('current')
  try {
    drag('dragenter'); expect(document.querySelectorAll('[data-workspace-chain-reference-overlay]')).toHaveLength(1)
    drag('drop'); expect(current.insert).toHaveBeenCalledTimes(1); expect(hidden.insert).not.toHaveBeenCalled()
    hidden.host.hidden = false
    expect(drag('drop').defaultPrevented).toBe(false)
    drag('dragenter', current.host); expect(overlay()).not.toBeNull()
    drag('dragenter', hidden.host); expect(document.querySelectorAll('[data-workspace-chain-reference-overlay]')).toHaveLength(1)
    drag('drop', hidden.host); expect(hidden.insert).toHaveBeenCalledTimes(1); expect(overlay()).toBeNull()
    drag('drop', current.host); expect(current.insert).toHaveBeenCalledTimes(2); expect(hidden.insert).toHaveBeenCalledTimes(1)
  } finally { current.clean(); hidden.clean() }
})
