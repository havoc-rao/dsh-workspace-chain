import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (`ctx.slots`) into the
// client Context, same as every other client plugin.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHANNEL, OWNER_ENDPOINT, isCatalog, isOwnerOfResult, type OwnerOfResult } from '../shared/catalog.js'
import { DelegationRow } from './DelegationRow.js'
import { armToolviewSlot } from './toolview-slot.js'
import { ReferenceDock } from './ReferenceDock.js'
import { referenceInsert, type ReferenceItem } from '../shared/references.js'
import { WorkspaceMessageReference, selectWorkspaceReference } from './WorkspaceMessageReference.js'
import { EscalationDelegation } from './EscalationDelegation.js'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { REFERENCE_NS, referenceZh, referenceEn } from './reference-locales.js'
export const inject = ['connection', 'slots', 'locale']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(REFERENCE_NS, { zh: referenceZh, en: referenceEn }), 'workspace-chain: reference dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const load = async () => {
    const result = await connection.rpc.call(CHANNEL, 'catalog', {})
    if (!result.ok) throw new Error(result.error.message)
    if (!isCatalog(result.value)) throw new Error('Invalid workspace-chain catalog')
    return result.value
  }
  const queryOwner = async (path: string, sessionId: string): Promise<OwnerOfResult> => {
    const result = await connection.rpc.call(CHANNEL, OWNER_ENDPOINT, { path, sessionId })
    if (!result.ok) throw new Error(result.error.message)
    if (!isOwnerOfResult(result.value)) throw new Error('Invalid workspace-chain ownerOf result')
    return result.value
  }
  ctx.slots.inject('conversation.message.reference', () => ctx.slots.register({
    name: 'conversation.message.reference', priority: -10, select: selectWorkspaceReference, locale: REFERENCE_NS,
  }, WorkspaceMessageReference))
  const references = (): ReferenceItem[] => {
    const sessions = ctx.get('sessions') as unknown as ISessions | undefined
    const workspaces = ctx.get('workspaces') as unknown as IWorkspaces | undefined
    const state = sessions?.list.getSnapshot()
    const projects = workspaces?.list.getSnapshot().items ?? []
    return [
      ...projects.map(item => ({ kind: 'workspace' as const, id: item.workspaceId, label: item.title, description: item.path })),
      ...(state?.ids ?? []).flatMap((id: SessionId) => {
        const item = state!.byId[id]
        return item && !item.blank ? [{ kind: 'session' as const, id, label: item.displayTitle, description: item.cwd ?? '', updatedAt: item.updatedAt, parentId: item.parentId, origin: item.origin, workspaceId: projects.find(project => project.sessionIds.includes(id) || project.path === item.cwd)?.workspaceId }] : []
      }),
    ]
  }
  // Input-area entry is drag-only: sidebar workspace/session rows drop into the
  // composer through this slot's dock (validated by `references()`), which also
  // owns the full-screen reference mask. The former `@` menu/button and hover
  // previews were removed.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'workspace-chain-references', order: 30 },
    (props: PropsRuntime<'conversation.input.left'>) => {
      const input = props.useInput(state => state)
      return <ReferenceDock items={references} disabled={input.phase !== 'plain'} insert={item => {
        const sessions = ctx.get('sessions') as unknown as ISessions
        const scope = sessions.scope(props.sessionId)
        if (!scope) return false
        const end = input.draft.length
        return scope.bail(scope, 'slash/input-insert-reference', { reference: referenceInsert(item), span: { start: end, end, draftRev: input.draftRev } }) === true
      }} />
    }))
  // Keyed toolview ownership is async (the catalog RPC decides the wire tool
  // name), while DSH's keyed dispatch falls back to the generic card for
  // unclaimed keys. A single failed catalog fetch would degrade every
  // delegation row to the plain generic card for the whole app session, so
  // armToolviewSlot retries with bounded backoff and re-arms on every
  // connection reset (initial connect, host restart, reconnect).
  ctx.slots.inject('tool.call.toolview', () => {
    const arm = armToolviewSlot({
      load,
      register: toolName => ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, DelegationRow),
      onReset: listener => ctx.on('connection/reset', listener),
    })
    return () => { arm.dispose() }
  })
  // Escalation-approval detail: shadow the shipped command row (priority -10
  // wins the single cell) with the command display plus the cross-workspace
  // ownership query for sandbox-blocked edits. Registered via inject so the
  // slot's declaration (owned by the approval composer) is live first.
  ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register(
    { name: 'conversation.approval.detail', priority: -10 },
    (props: PropsRuntime<'conversation.approval.detail'>) => <EscalationDelegation {...props} queryOwner={queryOwner} />,
  ))
}