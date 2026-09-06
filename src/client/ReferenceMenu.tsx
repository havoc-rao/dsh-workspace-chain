import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { MenuViewInjected } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceItem } from '../shared/references.js'
import { flattenReferences, referenceTree, type ReferenceNode } from './reference-tree.js'
export type ReferenceMenuProps = MenuViewInjected & { references: () => readonly ReferenceItem[]; currentWorkspace: () => string | undefined }

// Keep the host's light/dark menu tokens. Pixel line heights must be strings:
// React serializes numeric lineHeight as a font-size multiplier, not pixels.
const c = {
  surface: 'var(--dsw-specific-menu, var(--background-color, Canvas))',
  text: 'var(--dsw-alias-label-primary, var(--text-color, CanvasText))',
  secondary: 'var(--dsw-alias-label-secondary, var(--text-color, CanvasText))',
  tertiary: 'var(--dsw-alias-label-tertiary, #777)',
  caption: 'var(--dsw-alias-label-caption, #888)',
  hover: 'var(--dsw-alias-interactive-bg-hover, var(--background-hover, #8882))',
  hairline: 'var(--dsw-alias-border-subtle, #8883)',
  shadow: 'var(--dsw-shadow-lv3, 0 8px 32px #0002)',
  accent: 'var(--dsw-alias-state-business-primary, var(--ds-color-accent, #4c8dff))',
}
// Keep the overlay itself in block flow as the scroll container. A nested flex
// scroller can collapse inside the host's absolutely positioned auto-height menu.
const surface = {
  position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 20,
  boxSizing: 'border-box', maxHeight: 'min(360px, 50vh)', overflowY: 'auto',
  overflowX: 'hidden', overscrollBehavior: 'contain', padding: 6,
  border: `1px solid ${c.hairline}`, borderRadius: 12,
  background: c.surface, color: c.text, boxShadow: c.shadow,
  fontFamily: 'inherit', fontSize: 13, lineHeight: '20px',
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2, #8884)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2, #8888)',
} as CSSProperties
const button: CSSProperties = {
  appearance: 'none', boxSizing: 'border-box', margin: 0, border: 'none',
  fontFamily: 'inherit', fontSize: 13, lineHeight: '20px', color: 'inherit',
  cursor: 'pointer', transition: 'background 100ms ease, color 100ms ease',
}
const chip = (pressed: boolean): CSSProperties => ({
  ...button, display: 'inline-flex', alignItems: 'center', minWidth: 0,
  maxWidth: '100%', height: 26, padding: '0 8px', borderRadius: 6,
  background: pressed ? c.hover : 'transparent',
  color: pressed ? c.accent : c.secondary,
  fontSize: 12, lineHeight: '18px', fontWeight: 500, whiteSpace: 'nowrap',
})
const crumbBar: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '0 2px 6px', marginBottom: 4, borderBottom: `1px solid ${c.hairline}` }
const crumbGroup: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, flex: '1 1 auto', minWidth: 0 }
const crumbSep: CSSProperties = { color: c.caption, fontSize: 12, lineHeight: '18px', userSelect: 'none' }
const listbox: CSSProperties = { outline: 'none' }
const section: CSSProperties = { padding: '8px 10px 4px', color: c.tertiary, fontSize: 11, lineHeight: '16px', fontWeight: 600 }
const cell: CSSProperties = {
  ...button, display: 'flex', alignItems: 'center', gap: 10, width: '100%',
  minHeight: 36, padding: '7px 10px', borderRadius: 7,
  background: 'transparent', textAlign: 'left',
}
const option: CSSProperties = { ...cell, padding: '6px 10px' }
const name: CSSProperties = { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: '20px', fontWeight: 500 }
const desc: CSSProperties = { ...name, color: c.tertiary, fontSize: 12, lineHeight: '18px', fontWeight: 400 }
const cellValue: CSSProperties = { flex: '0 1 45%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', color: c.tertiary, fontSize: 12, lineHeight: '18px' }
const cellChevron: CSSProperties = { flex: '0 0 auto', color: c.caption, width: 14, height: 14 }
const status: CSSProperties = { padding: '20px 12px', textAlign: 'center', color: c.tertiary, fontSize: 13, lineHeight: '20px' }
const footer: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6, padding: '8px 10px 2px', borderTop: `1px solid ${c.hairline}`, color: c.tertiary, fontSize: 11, lineHeight: '18px' }
const keycap: CSSProperties = { display: 'inline-block', padding: '0 4px', border: `1px solid ${c.hairline}`, borderRadius: 4, fontFamily: 'inherit', fontSize: 10, lineHeight: '15px', color: c.secondary }
const selectedRow = (selected: boolean): CSSProperties => ({
  background: selected ? c.hover : 'transparent',
  boxShadow: selected ? `inset 2px 0 ${c.accent}` : 'none',
})

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
  const busy = state.groups.some(group => group.status === 'pending')
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
  return <div ref={container} style={surface}>
    {at && <div style={crumbBar}>
      <div style={crumbGroup}>
        <button type="button" aria-pressed={path.length === 0} style={chip(path.length === 0)} onMouseDown={event => event.preventDefault()} onClick={() => { setPath([]); setActive(0) }}>全部来源</button>
        {crumbs.map((node, index) => <Fragment key={node.id}>
          <span aria-hidden="true" style={crumbSep}>›</span>
          <button type="button" aria-pressed={index === crumbs.length - 1} style={chip(index === crumbs.length - 1)} onMouseDown={event => event.preventDefault()} onClick={() => { setPath(path.slice(0, index + 1)); setActive(0) }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</span></button>
        </Fragment>)}
      </div>
      <button type="button" aria-pressed={all} style={chip(all)} onMouseDown={event => event.preventDefault()} onClick={() => { setAll(!all); setActive(0) }}>{all ? '分层浏览' : '分类列表'}</button>
    </div>}
    <div role="listbox" aria-label={at ? '分层引用选择' : '命令选择'} aria-busy={busy} aria-activedescendant={rows.length ? `${id}-${selection}` : undefined} style={listbox}>
      {rows.map((node, index) => <Fragment key={node.id}>
        {node.section && node.section !== rows[index - 1]?.section && <div role="presentation" style={section}>{node.section}</div>}
        {node.children
          ? <button id={`${id}-${index}`} type="button" role="option" aria-selected={index === selection}
            style={{ ...cell, ...selectedRow(index === selection) }} title={node.description}
            onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); choose(node) }}>
            <span style={{ ...name, flex: '1 1 auto' }}>{node.label}</span>
            {node.description && <span style={cellValue}>{node.description}</span>}
            <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" style={cellChevron}><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          : <button id={`${id}-${index}`} type="button" role="option" aria-selected={index === selection}
            style={{ ...option, ...selectedRow(index === selection) }} title={node.description}
            onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); choose(node) }}>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
              <span style={name}>{node.label}</span>
              {node.description && <span style={desc}>{node.description}</span>}
            </span>
          </button>}
      </Fragment>)}
      {!rows.length && <div role="status" style={status}>{busy ? '搜索中…' : '当前来源没有匹配项'}</div>}
    </div>
    <div style={footer}>
      <span>{busy ? '搜索中…' : `继续输入搜索${at ? crumbs.length ? '当前来源' : '各来源' : '命令'}`}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <span><kbd style={keycap}>↑↓</kbd> 选择</span>
        <span><kbd style={keycap}>Enter</kbd> {rows[selection]?.children ? '进入' : at ? '引用' : '选择'}</span>
        <span><kbd style={keycap}>Esc</kbd> {crumbs.length ? '返回' : '关闭'}</span>
      </span>
    </div>
  </div>
}