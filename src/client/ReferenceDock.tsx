import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { REFERENCE_MIME, resolveDrop, type ReferenceItem } from '../shared/references.js'
import type { ReferenceTranslate } from './reference-locales.js'
import { ReferenceDropOverlay } from './ReferenceDropOverlay.js'

const mountedDocks = new Map<HTMLSpanElement, () => void>()
function visible(anchor: HTMLElement): boolean {
  if (!anchor.isConnected || anchor.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  for (let node: HTMLElement | null = anchor; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** Single reference-drop owner. File drops and sidebar reordering remain native. */
export function ReferenceDock({ items, insert, disabled = false, sessionId, t }: {
  items: () => readonly ReferenceItem[]; insert: (item: ReferenceItem) => boolean; disabled?: boolean
  sessionId: string; t: ReferenceTranslate
}) {
  const [active, setActive] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<'invalidDrop' | 'blockedDrop' | ''>('')
  const anchor = useRef<HTMLSpanElement>(null)
  const latest = useRef({ items, insert, disabled, sessionId })
  latest.current = { items, insert, disabled, sessionId }
  useEffect(() => {
    const dock = anchor.current!
    let depth = 0
    let showing = false
    const reset = () => {
      depth = 0
      if (showing) { showing = false; setActive(false) }
    }
    mountedDocks.set(dock, reset)
    const transferOf = (event: DragEvent) => event.dataTransfer?.types.includes(REFERENCE_MIME)
      && !event.dataTransfer.types.includes('Files') ? event.dataTransfer : undefined
    const owns = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('[role="treeitem"], [role="tree"], [data-dsh-enhanced-workspace="browser"]')) return false
      // Core's resident ConversationContent publishes this real session marker.
      // A targeted visible occurrence wins; outside it, accept only when exactly
      // one visible dock exists, rather than guessing which split view is current.
      const occurrence = target.closest('[data-conversation-session]')
      const candidates = [...mountedDocks.keys()].filter(visible)
      if (occurrence) return candidates.find(candidate => occurrence.contains(candidate)) === dock
        && occurrence.getAttribute('data-conversation-session') === latest.current.sessionId
      return candidates.length === 1 && candidates[0] === dock
    }
    const writable = () => {
      const input = anchor.current?.closest('[data-composer-card]')?.querySelector('textarea')
      return !latest.current.disabled && !(input?.disabled || input?.readOnly)
    }
    const claim = (event: DragEvent) => {
      // A capture claim suppresses other docks' listeners too, so reset their
      // previous overlays explicitly when ownership changes between occurrences.
      for (const [candidate, clear] of mountedDocks) if (candidate !== dock) clear()
      event.preventDefault(); event.stopImmediatePropagation()
    }
    const over = (event: DragEvent) => {
      const transfer = transferOf(event)
      if (!transfer || !owns(event)) { reset(); return false }
      claim(event)
      const canWrite = writable()
      transfer.dropEffect = canWrite ? 'copy' : 'none'
      if (!showing) {
        showing = true
        // Native drag events are not React discrete events. Commit the first
        // mask now instead of waiting behind the sidebar's concurrent rerender.
        flushSync(() => { setBlocked(!canWrite); setError(''); setActive(true) })
      } else setBlocked(!canWrite)
      return true
    }
    const enter = (event: DragEvent) => {
      if (over(event)) depth += 1
    }
    const leave = (event: DragEvent) => {
      if (!transferOf(event)) return
      depth = Math.max(0, depth - 1)
      const target = event.relatedTarget instanceof Element ? event.relatedTarget : null
      if (target) {
        if (target.closest('[role="treeitem"], [role="tree"], [data-dsh-enhanced-workspace="browser"]')) reset()
        return
      }
      const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if (!depth || ((event.target === document.body || event.target === document.documentElement) && leftViewport)) reset()
    }
    const drop = (event: DragEvent) => {
      const transfer = transferOf(event)
      reset()
      if (!transfer || !owns(event)) return
      // Claim BEFORE parsing/validation/insertion. Even rejected references must
      // not reach another listener or become raw browser text in the editor.
      claim(event)
      const item = resolveDrop(transfer, latest.current.items())
      setError(!item ? 'invalidDrop' : !writable() || !latest.current.insert(item) ? 'blockedDrop' : '')
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      mountedDocks.delete(dock)
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return <span ref={anchor} aria-label={t('references')} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
    {active && <ReferenceDropOverlay blocked={disabled || blocked} t={t} />}
    {error && <span role="status" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 240, padding: 10, borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', boxShadow: 'var(--dsw-elevation-soft)', zIndex: 25, pointerEvents: 'none' }}>{t(error)}</span>}
  </span>
}
