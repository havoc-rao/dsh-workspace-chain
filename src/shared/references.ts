export const REFERENCE_MIME = 'application/x-dsh-reference+json'
export interface ReferenceItem { kind: 'session' | 'workspace'; id: string; label: string; description: string; workspaceId?: string; parentId?: string; origin?: 'subagent'; updatedAt?: number }
export function sessionReferenceIds(text: string): string[] {
  return [...new Set([...text.matchAll(/dsh-session:([A-Za-z0-9_-]+)/g)].flatMap(match => {
    try {
      const bytes = Uint8Array.from(atob(match[1]!.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
      const id: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (typeof id !== 'string' || !id) return []
      const canonical = referenceInsert({ kind: 'session', id, label: '', description: '' }).ref
      return canonical.includes(`(dsh-session:${match[1]})`) ? [id] : []
    } catch { return [] }
  }))]
}
export function workspaceReference(id: string, label?: string): string {
  if (label === undefined) return `@workspace-id/${encodeURIComponent(id)}`
  const payload = btoa(Array.from(new TextEncoder().encode(JSON.stringify({ id, label })), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `@workspace-ref/${payload}`
}
export interface WorkspaceMention { ref: string; id: string; label?: string }
/** Identity is always explicit; a display label is never used to select a workspace. */
export function workspaceMentions(text: string): WorkspaceMention[] {
  return [...text.matchAll(/@workspace-(?:ref\/[A-Za-z0-9_-]+|id\/[^\s,，。;；!?！？)\]}>]+)/gu)].flatMap(match => {
    const ref = match[0]
    try {
      if (ref.startsWith('@workspace-id/')) return [{ ref, id: decodeURIComponent(ref.slice(14)) }]
      const raw = ref.slice(15)
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!value || typeof value !== 'object') return []
      const { id, label } = value as Record<string, unknown>
      if (typeof id !== 'string' || !id || typeof label !== 'string' || workspaceReference(id, label) !== ref) return []
      return [{ ref, id, label }]
    } catch { return [] }
  })
}
export function referenceInsert(item: ReferenceItem) {
  const payload = btoa(Array.from(new TextEncoder().encode(JSON.stringify(item.id)), byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const ref = item.kind === 'workspace' ? workspaceReference(item.id, item.label)
    : `@[${item.label.replace(/[\\\]]/gu, match => `\\${match}`)}](dsh-session:${payload})`
  // Serialization reuses the built-in `reference` source's identity codec: the
  // ref text is already the model form (@workspace-ref/…, @[label](dsh-session:…)).
  return { source: 'reference', ref, label: item.label, appearance: item.kind === 'session' ? 'session' as const : 'folder' as const, clipboardText: ref }
}
export function resolveDrop(transfer: Pick<DataTransfer, 'getData'>, items: readonly ReferenceItem[]): ReferenceItem | undefined {
  const raw = transfer.getData(REFERENCE_MIME)
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object') return undefined
      const payload = value as { version?: unknown; kind?: unknown; id?: unknown }
      if (payload.version !== 1) return undefined
      return items.find(item => item.kind === payload.kind && item.id === payload.id)
    } catch { return undefined }
  }
  // Compatibility with existing sidebar workspace drags. Never interpret paths or arbitrary text.
  const id = transfer.getData('text/plain')
  return items.find(item => item.kind === 'workspace' && item.id === id)
}
export function workspaceReferenceIds(text: string): string[] {
  return [...new Set(workspaceMentions(text).map(mention => mention.id))]
}
