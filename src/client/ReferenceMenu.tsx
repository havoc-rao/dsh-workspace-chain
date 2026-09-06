import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { MenuViewInjected } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceItem } from '../shared/references.js'
import { flattenReferences, referenceTree, type ReferenceNode } from './reference-tree.js'
export type ReferenceMenuProps = MenuViewInjected & { references: () => readonly ReferenceItem[]; currentWorkspace: () => string | undefined }
export function ReferenceMenu({ menu, onPick, onDismiss, references, currentWorkspace }: ReferenceMenuProps) {
  const state = useSyncExternalStore(fn => menu.subscribe(fn), () => menu.getSnapshot())
  const [path, setPath] = useState<string[]>([])
  const [all, setAll] = useState(false)
  const [active, setActive] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const id = useId()
  const at = state.hit?.trigger === '@'
  const tree = referenceTree(state, references(), currentWorkspace())
  let nodes = tree
  const crumbs: ReferenceNode[] = []
  for (const key of path) {
    const node = nodes.find(item => item.id === key)
    if (!node?.children) break
    crumbs.push(node); nodes = node.children
  }
  const searching = Boolean(state.hit?.query)
  const rows = at ? all || searching ? flattenReferences(nodes) : nodes : flattenReferences(tree)
  const selection = Math.min(active, Math.max(0, rows.length - 1))
  const choose = (node: ReferenceNode) => {
    if (node.children) { setPath([...crumbs.map(item => item.id), node.id]); setActive(0) }
    else if (node.pick) onPick(node.pick.source, node.pick.index)
  }
  useEffect(() => { if (!state.open) { setPath([]); setAll(false); setActive(0) } }, [state.open])
  useEffect(() => { setActive(0) }, [state.hit?.query])
  // The composer retains focus. Capture only navigation keys within this composer,
  // so the native flat-menu keyboard handler cannot pick a hidden candidate.
  useEffect(() => {
    if (!state.open) return
    const card = () => container.current?.closest('[data-composer-card]')
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Node) || !card()?.contains(event.target)) return
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        if (path.length) { setPath(path.slice(0, -1)); setActive(0) } else onDismiss()
      } else if (event.key === 'Enter') { if (rows[selection]) choose(rows[selection]) }
      else if (rows.length) setActive((selection + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    }
    const pointerdown = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target) && !card()?.contains(event.target)) onDismiss()
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', pointerdown, true)
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('pointerdown', pointerdown, true) }
  })
  useEffect(() => { container.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [selection])
  if (!state.open) return null
  return <div ref={container} style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 20, maxHeight: 'min(360px, 50vh)', overflowY: 'auto', padding: 8, border: '1px solid var(--border-color, #888)', borderRadius: 10, background: 'var(--background-color, Canvas)', color: 'var(--text-color, CanvasText)', boxShadow: '0 6px 24px #0002' }}>
    {at && <div style={{ display: 'flex', gap: 8, padding: 4, flexWrap: 'wrap' }}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setPath([]); setActive(0) }}>全部来源</button>
      {crumbs.map((node, index) => <button key={node.id} type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setPath(path.slice(0, index + 1)); setActive(0) }}>{node.label}</button>)}
      <button type="button" aria-pressed={all} onMouseDown={event => event.preventDefault()} onClick={() => { setAll(!all); setActive(0) }}>{all ? '分层浏览' : '分类列表'}</button>
    </div>}
    <div role="listbox" aria-label={at ? '分层引用选择' : '命令选择'} aria-activedescendant={rows.length ? `${id}-${selection}` : undefined}>
      {rows.map((node, index) => <Fragment key={node.id}>
        {node.section && node.section !== rows[index - 1]?.section && <div role="presentation" style={{ padding: '8px 10px 2px', fontSize: 12, opacity: .65 }}>{node.section}</div>}
        <button id={`${id}-${index}`} type="button" role="option" aria-selected={index === selection}
        style={{ display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left', border: 0, borderRadius: 6, padding: '8px 10px', color: 'inherit', background: index === selection ? 'var(--background-hover, #8882)' : 'transparent' }}
        onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); choose(node) }}>
        <span>{node.label}{node.children ? ' ›' : ''}</span>
        {node.description && <small style={{ opacity: .65, overflowWrap: 'anywhere' }}>{node.description}</small>}
      </button></Fragment>)}
      {!rows.length && <div role="status" style={{ padding: 10 }}>{state.groups.some(group => group.status === 'pending') ? '搜索中…' : '当前来源没有匹配项'}</div>}
    </div>
    {at && <div style={{ padding: 4, opacity: .65, fontSize: 12 }}>继续输入搜索{crumbs.length ? '当前来源' : '各来源'} · ↑↓ 选择 · Enter 进入或引用 · Esc 返回</div>}
  </div>
}
