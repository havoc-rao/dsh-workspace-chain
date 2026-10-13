import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ReferenceIconRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { REFERENCE_NS } from './reference-locales.js'
import { workspaceMentions, type WorkspaceMention } from '../shared/references.js'

// The upgraded host owns this slot contract; do not shadow its public owner type.
export function selectWorkspaceReference(owner: { token: string }): WorkspaceMention | null {
  return workspaceMentions(owner.token).find(mention => mention.ref === owner.token) ?? null
}
export function WorkspaceMessageReference({ matched, useWorkspaces, t }: PropsRuntime<'conversation.message.reference'> & { matched: WorkspaceMention } & PropsLocale<typeof REFERENCE_NS>) {
  const workspace = useWorkspaces(state => state.items.find(item => item.workspaceId === matched.id))
  const label = workspace?.title ?? (matched.label || t('unavailable'))
  // Match the shared user-text chip's inline baseline and consumer wrapping policy.
  return <Tooltip label={matched.ref} side="bottom" delayMs={500} portal maxWidth={480}>
    <span data-ref-chip="workspace" tabIndex={0}>
    <span style={{ display: 'inline-block', width: '1em', height: '1em', marginRight: 4, verticalAlign: '-0.125em' }}><ReferenceIconRegular kind="folder" size={16} /></span>
    {label}
    </span>
  </Tooltip>
}
