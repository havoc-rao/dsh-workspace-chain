import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ReferenceIconRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReferenceTranslate } from './reference-locales.js'
import { workspaceMentions, type WorkspaceMention } from '../shared/references.js'

// Contract for the generic host seam. This also allows compiling against the
// older published UI type package; registration waits for the host declaration.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.message.reference': {
      kind: 'chain'
      scope: 'session'
      owner: { token: string }
    }
  }
}
export function selectWorkspaceReference(owner: { token: string }): WorkspaceMention | null {
  return workspaceMentions(owner.token).find(mention => mention.ref === owner.token) ?? null
}
export function WorkspaceMessageReference({ matched, useWorkspaces, t }: PropsRuntime<'conversation.message.reference'> & { matched: WorkspaceMention; t: ReferenceTranslate }) {
  const workspace = useWorkspaces(state => state.items.find(item => item.workspaceId === matched.id))
  const label = workspace?.title ?? (matched.label || t('unavailable'))
  // Match the shared user-text chip's inline baseline and consumer wrapping policy.
  return <Tooltip label={matched.ref} side="bottom" delayMs={500} portal maxWidth={480}>
    <span data-ref-chip="workspace" tabIndex={0} style={{ display: 'inline', maxWidth: '100%', margin: '0 2px', color: 'var(--dsw-alias-state-business-primary)', fontWeight: 500, whiteSpace: 'inherit', overflowWrap: 'anywhere', textAlign: 'inherit' }}>
    <span style={{ display: 'inline-block', width: '1em', height: '1em', marginRight: 4, verticalAlign: '-0.125em' }}><ReferenceIconRegular kind="folder" size={16} /></span>
    {label}
    </span>
  </Tooltip>
}
