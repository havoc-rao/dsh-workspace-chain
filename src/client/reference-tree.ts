import type { MenuViewInjected } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceItem } from '../shared/references.js'
type MenuState = ReturnType<MenuViewInjected['menu']['getSnapshot']>
export interface ReferenceNode { id: string; label: string; description?: string; section?: string; children?: ReferenceNode[]; pick?: { source: string; index: number } }
const sourceLabels: Record<string, string> = { reference: '会话引用', file: '文件', skill: '技能', command: '命令' }
export function referenceTree(state: MenuState, references: readonly ReferenceItem[], currentWorkspace?: string): ReferenceNode[] {
  const leaves = new Map<string, ReferenceNode>()
  const targets: ReferenceNode[] = []
  const others: ReferenceNode[] = []
  for (const group of state.groups) {
    const children = group.items.map((item, index) => ({ id: `${group.source}:${index}`, label: item.name, description: item.description, pick: { source: group.source, index } }))
    if (group.source !== 'workspace-chain') {
      others.push({ id: `source:${group.source}`, label: sourceLabels[group.source] ?? group.source, description: group.status === 'pending' ? '搜索中…' : `${children.length} 项`, children })
      continue
    }
    group.items.forEach((item, index) => {
      try {
        const value = JSON.parse(item.value ?? '') as { kind: string; id: string }
        const leaf = children[index]!
        if (value.kind === 'target') targets.push(leaf)
        else leaves.set(`${value.kind}:${value.id}`, leaf)
      } catch { /* Foreign candidates are never interpreted as reference IDs. */ }
    })
  }
  const sessions = references.filter(item => item.kind === 'session')
  const sessionNode = (item: ReferenceItem, seen = new Set<string>()): ReferenceNode | undefined => {
    if (seen.has(item.id)) return undefined
    const next = new Set(seen).add(item.id)
    const children: ReferenceNode[] = []
    const self = leaves.get(`session:${item.id}`)
    if (self) children.push({ ...self, label: '引用此 session' })
    for (const child of sessions.filter(child => child.parentId === item.id && child.workspaceId === item.workspaceId)) {
      const node = sessionNode(child, next)
      if (node) children.push({ ...node, label: `${child.origin === 'subagent' ? '子代理' : 'fork'} · ${child.label}` })
    }
    return { id: `session:${item.id}`, label: item.label, description: item.description, children }
  }
  const roots = (workspaceId?: string) => sessions.filter(item => item.workspaceId === workspaceId && !sessions.some(parent => parent.id === item.parentId && parent.workspaceId === workspaceId))
    .flatMap(item => { const node = sessionNode(item); return node ? [node] : [] })
  const workspaces = references.filter(item => item.kind === 'workspace').map(item => {
    const self = leaves.get(`workspace:${item.id}`)
    return { id: `workspace:${item.id}`, label: item.label, description: item.description,
      children: [...self ? [{ ...self, label: '引用 workspace 本身' }] : [], ...roots(item.id)] }
  })
  const currentIndex = workspaces.findIndex(item => item.id === `workspace:${currentWorkspace}`)
  if (currentIndex > 0) workspaces.unshift(...workspaces.splice(currentIndex, 1))
  const unassigned = roots()
  return [
    { id: 'workspaces', label: 'workspace', children: [
      ...workspaces,
      ...unassigned.length ? [{ id: 'sessions', label: '未归属工作区的会话', children: unassigned }] : [],
    ] },
    { id: 'targets', label: '已配置委托目标', children: targets },
    ...others,
  ]
}
export function flattenReferences(nodes: readonly ReferenceNode[], path = ''): ReferenceNode[] {
  return nodes.flatMap(node => node.children ? flattenReferences(node.children, path ? `${path} / ${node.label}` : node.label)
    : [{ ...node, section: path, description: [path, node.description].filter(Boolean).join(' · ') }])
}
