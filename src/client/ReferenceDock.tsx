import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { REFERENCE_MIME, resolveDrop, type ReferenceItem } from '../shared/references.js'
export function ReferenceDock({ items, insert, open, disabled = false }: {
  items: () => readonly ReferenceItem[]; insert: (item: ReferenceItem) => boolean; open?: () => void; disabled?: boolean
}) {
  const [active, setActive] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState('')
  const anchor = useRef<HTMLSpanElement>(null)
  const latest = useRef({ items, insert, disabled })
  latest.current = { items, insert, disabled }
  useEffect(() => {
    let depth = 0
    const reset = () => { depth = 0; setActive(false) }
    // Files remain owned by the native image drop layer. Plain text is not
    // intercepted globally: browsers protect its payload during dragover.
    const transferOf = (event: DragEvent) => event.dataTransfer?.types.includes(REFERENCE_MIME)
      && !event.dataTransfer.types.includes('Files') ? event.dataTransfer : undefined
    const inTree = (event: DragEvent) => event.target instanceof Element && event.target.closest('[role="treeitem"], [role="tree"], [data-dsh-enhanced-workspace="browser"]') !== null
    const writable = () => {
      const input = anchor.current?.closest('[data-composer-card]')?.querySelector('textarea')
      return !latest.current.disabled && !(input?.disabled || input?.readOnly)
    }
    const enter = (event: DragEvent) => {
      if (!transferOf(event) || inTree(event)) return
      event.preventDefault(); depth += 1; setBlocked(!writable()); setActive(true)
    }
    const over = (event: DragEvent) => {
      const transfer = transferOf(event)
      if (!transfer) return
      if (inTree(event)) { reset(); return }
      event.preventDefault(); transfer.dropEffect = writable() ? 'copy' : 'none'; setBlocked(!writable()); setActive(true)
    }
    const leave = (event: DragEvent) => {
      if (!transferOf(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth || event.relatedTarget === null) reset()
    }
    const drop = (event: DragEvent) => {
      const transfer = transferOf(event)
      if (!transfer) return
      reset()
      if (inTree(event)) return
      event.preventDefault()
      const item = resolveDrop(transfer, latest.current.items())
      setError(!item ? '无法识别此引用，请通过 @ 选择。' : !writable() || !latest.current.insert(item) ? '暂时无法插入，请重试或通过 @ 选择。' : '')
    }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragover', over)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragover', over)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return <span ref={anchor} aria-label="Session and workspace references" style={{ display: 'inline-flex', position: 'relative', alignItems: 'center' }}>
    <button type="button" aria-label="添加 workspace 或 session 引用" aria-haspopup="listbox" disabled={disabled}
      title="添加引用 · 也可将 workspace 或 session 拖入页面"
      onMouseDown={event => event.preventDefault()} onClick={() => { setError(''); open?.() }}
      style={{ border: 0, borderRadius: 6, width: 28, height: 28, background: 'transparent', color: 'inherit', fontSize: 18, cursor: disabled ? 'default' : 'pointer' }}>@</button>
    {error && <span role="status" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 240, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', boxShadow: '0 4px 16px #0002', zIndex: 25 }}>{error}</span>}
    {active && createPortal(<div role="status" aria-label="引用拖放" style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', background: 'var(--dsw-alias-bg-mask-drop, #8883)', backdropFilter: 'blur(10px)', color: 'var(--dsw-alias-label-primary, CanvasText)', textAlign: 'center' }}>
      <span aria-hidden="true" style={{ fontSize: 56, color: 'var(--dsw-alias-label-link, #3964fe)' }}>@</span>
      <strong style={{ fontSize: 20, marginTop: 16 }}>{disabled || blocked ? '当前无法添加引用' : '松开以添加 workspace / session 引用'}</strong>
      {!disabled && !blocked && <span style={{ fontSize: 14, marginTop: 16 }}>引用将加入当前输入框</span>}
    </div>, document.body)}
  </span>
}
