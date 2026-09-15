import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHANNEL, OWNER_ENDPOINT, isCatalog, isOwnerOfResult, type OwnerOfResult } from '../shared/catalog.js'
import { createWorkspaceSource } from './source.js'
import { DelegationRow } from './DelegationRow.js'
import { ReferenceDock } from './ReferenceDock.js'
import { referenceInsert, type ReferenceItem } from '../shared/references.js'
import { ReferenceMenu } from './ReferenceMenu.js'
import { WorkspaceMessageReference, selectWorkspaceReference } from './WorkspaceMessageReference.js'
import { ReferencePreview } from './ReferencePreview.js'
import { EscalationDelegation } from './EscalationDelegation.js'
export const inject = ['inputTriggers', 'connection', 'slots']
export function apply(ctx: ClientContext): void {
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
    name: 'conversation.message.reference', priority: -10, select: selectWorkspaceReference,
  }, WorkspaceMessageReference))
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
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
  ctx.effect(() => triggers.registerSource(createWorkspaceSource(load, references)), 'workspace-chain: references')
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'slash-menu', priority: -10, order: 0,
    inject: sessionId => {
      const sessions = ctx.get('sessions') as unknown as ISessions
      const scope = sessions.scope(sessionId)
      if (!scope) throw new Error('Reference menu session is unavailable')
      const controller = triggers.sessionOf(scope)
      return { menu: controller.menu, onPick: (source: string, index: number) => { controller.pick(source, index) }, onDismiss: () => controller.dismiss(),
        references, currentWorkspace: () => {
          const current = sessions.list.getSnapshot().byId[sessionId]
          return (ctx.get('workspaces') as unknown as IWorkspaces | undefined)?.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId) || item.path === current?.cwd)?.workspaceId
        } }
    },
  }, ReferenceMenu))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'workspace-chain-references', order: 30 },
    (props: PropsRuntime<'conversation.input.left'>) => {
      const input = props.useInput(state => state)
      return <><ReferencePreview occurrences={input.occurrences} items={references} load={load} /><ReferenceDock items={references} disabled={input.phase !== 'plain'} open={() => {
        const sessions = ctx.get('sessions') as unknown as ISessions
        const scope = sessions.scope(props.sessionId)
        if (!scope) return
        const end = input.draft.length
        scope.bail(scope, 'slash/input-insert-text', { text: `${end && !/\s$/.test(input.draft) ? ' ' : ''}@`, span: { start: end, end, draftRev: input.draftRev }, continue: true })
      }} insert={item => {
        const sessions = ctx.get('sessions') as unknown as ISessions
        const scope = sessions.scope(props.sessionId)
        if (!scope) return false
        const end = input.draft.length
        return scope.bail(scope, 'slash/input-insert-reference', { reference: referenceInsert(item), span: { start: end, end, draftRev: input.draftRev } }) === true
      }} /></>
    }))
  // Wait for the owning tool slot; catalog is refreshed on each activation and menu request.
  ctx.slots.inject('tool.call.toolview', () => {
    let disposed = false
    let remove: (() => void) | undefined
    const pending = load().then(catalog => {
      if (disposed) return
      remove = ctx.slots.register({ name: 'tool.call.toolview', key: catalog.toolName }, DelegationRow)
    })
    pending.catch(error => { if (!disposed) console.error('workspace-chain UI:', error) })
    return () => { disposed = true; remove?.() }
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
