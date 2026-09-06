import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceMentions, type WorkspaceMention } from '../shared/references.js'

// Contract for the generic host seam. This also allows compiling against the
// older published UI type package; registration waits for the host declaration.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.message.reference': {
      kind: 'chain'
      scope: 'session'
      owner: { token: string; label: string; displayLabel: string; kind: 'file' | 'folder' | 'session' | 'skill' }
    }
  }
}
export function selectWorkspaceReference(owner: { token: string }): WorkspaceMention | null {
  return workspaceMentions(owner.token).find(mention => mention.ref === owner.token) ?? null
}
export function WorkspaceMessageReference({ matched, useWorkspaces }: PropsRuntime<'conversation.message.reference'> & { matched: WorkspaceMention }) {
  const workspace = useWorkspaces(state => state.items.find(item => item.workspaceId === matched.id))
  const label = workspace?.title ?? (matched.label || '工作区不可用')
  const description = workspace?.path ? `${label}\n${workspace.path}` : `${label}\n工作区当前不在列表中`
  return <span data-ref-chip="workspace" title={description} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'baseline', maxWidth: '100%', color: 'var(--dsw-alias-state-business-primary, var(--ds-color-accent, #4c8dff))' }}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flex: 'none', alignSelf: 'center' }}><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>
    <span style={{ overflowWrap: 'anywhere' }}>{label}</span>
  </span>
}
