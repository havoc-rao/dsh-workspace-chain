import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { sessionReferenceIds, workspaceReferenceIds, type ReferenceItem } from '../shared/references.js'
import type { Catalog } from '../shared/catalog.js'
interface Occurrence { occurrenceId: number; source: string; ref: string; label: string }
export function previewReference(ref: string, items: readonly ReferenceItem[]): ReferenceItem | undefined {
  const workspace = workspaceReferenceIds(ref)[0]
  const session = sessionReferenceIds(ref)[0]
  return items.find(item => workspace ? item.kind === 'workspace' && item.id === workspace : item.kind === 'session' && item.id === session)
}
export function ReferencePreview({ occurrences, items, load }: { occurrences: readonly Occurrence[]; items: () => readonly ReferenceItem[]; load: () => Promise<Catalog> }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const latest = useRef({ occurrences, items, load }); latest.current = { occurrences, items, load }
  const [preview, setPreview] = useState<{ item: ReferenceItem; workspace?: string; parent?: string; delegation?: string; x: number; y: number }>()
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (!card) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: string | undefined
    const clear = () => { clearTimeout(timer); current = undefined; setPreview(undefined) }
    const move = (event: Event) => {
      const pointer = event as PointerEvent
      // The native textarea overlays its decoration backdrop. Hit-test the
      // chip rectangles instead of changing textarea or backdrop pointer events.
      const chip = [...card.querySelectorAll<HTMLElement>('[data-decoration="chip"][data-occurrence]')].find(node =>
        [...node.getClientRects()].some(rect => pointer.clientX >= rect.left && pointer.clientX <= rect.right && pointer.clientY >= rect.top && pointer.clientY <= rect.bottom))
      const key = chip?.dataset.occurrence
      if (key === current) return
      clear()
      if (!chip || !key) return
      const occurrence = latest.current.occurrences.find(item => String(item.occurrenceId) === key)
      if (!occurrence) return
      current = key
      timer = setTimeout(() => {
        const all = latest.current.items()
        const item = previewReference(occurrence.ref, all)
        if (!item) return
        const rect = chip.getBoundingClientRect()
        setPreview({ item, workspace: all.find(row => row.kind === 'workspace' && row.id === item.workspaceId)?.label,
          parent: all.find(row => row.kind === 'session' && row.id === item.parentId)?.label,
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), y: Math.max(8, window.innerHeight - rect.top + 8) })
        void latest.current.load().then(catalog => {
          if (current !== key) return
          const names = catalog.workspaces?.find(w => w.id === (item.kind === 'workspace' ? item.id : item.workspaceId))?.targets ?? []
          setPreview(value => value && { ...value, delegation: names.length ? names.join('、') : '未配置委托目标' })
        }, () => { if (current === key) setPreview(value => value && { ...value, delegation: '无法读取委托配置' }) })
      }, 250)
    }
    card.addEventListener('pointermove', move)
    card.addEventListener('pointerleave', clear)
    card.addEventListener('input', clear)
    card.addEventListener('keydown', clear)
    card.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    return () => { current = undefined; clearTimeout(timer); card.removeEventListener('pointermove', move); card.removeEventListener('pointerleave', clear); card.removeEventListener('input', clear); card.removeEventListener('keydown', clear); card.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear) }
  }, [])
  return <><span ref={anchor} hidden />{preview && createPortal(<aside role="tooltip" aria-label="引用原始信息" style={{ position: 'fixed', left: preview.x, bottom: preview.y, zIndex: 1100, width: 300, maxWidth: 'calc(100vw - 32px)', maxHeight: '50vh', overflow: 'hidden', padding: 12, borderRadius: 10, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', boxShadow: '0 4px 24px #0003', border: '1px solid #8884', pointerEvents: 'none', fontSize: 12, overflowWrap: 'anywhere' }}>
    <strong>{preview.item.label}</strong>
    <div>{preview.item.kind === 'workspace' ? 'Workspace' : preview.item.origin === 'subagent' ? '子代理 session' : preview.item.parentId ? 'Fork session' : 'Session'}</div>
    <div>路径：{preview.item.description || '未提供'}</div>
    {preview.workspace && <div>所属项目：{preview.workspace}</div>}
    {preview.item.updatedAt !== undefined && <div>更新：{new Date(preview.item.updatedAt).toLocaleString()}</div>}
    {preview.item.parentId && <div>来源会话：{preview.parent ?? '原会话不可用'}</div>}
    <div>委托配置：{preview.delegation ?? '读取中…'}</div>
    <div style={{ marginTop: 8, opacity: .65 }}>引用用于提供上下文；委托任务会创建新会话。</div>
  </aside>, document.body)}</>
}
