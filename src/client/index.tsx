import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (`ctx.slots`) into the
// client Context, same as every other client plugin.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHANNEL, OWNER_ENDPOINT, isCatalog, isOwnerOfResult, type OwnerOfResult } from '../shared/catalog.js'
import { DelegationRow, type DelegationInjected } from './DelegationRow.js'
import { DelegationKind } from './DelegationKind.js'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DELEGATION_NS, delegationZh, delegationEn } from './delegation-locales.js'
import { armToolviewSlot } from './toolview-slot.js'
import { ReferenceDock } from './ReferenceDock.js'
import type { ReferenceItem } from '../shared/references.js'
import { insertInputReference } from './reference-insertion.js'
import { WorkspaceMessageReference, selectWorkspaceReference } from './WorkspaceMessageReference.js'
import { EscalationDelegation } from './EscalationDelegation.js'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { REFERENCE_NS, referenceZh, referenceEn } from './reference-locales.js'
import { installWorkspaceReferenceStyle } from './workspace-reference-style.js'
export const inject = ['connection', 'slots', 'locale', 'jobs', 'uiWorkspace']
// Host and browser compile in this repository, but their jobs services are
// distinct. Keep the browser entry on the real client contract explicitly.
export function apply(ctx: Omit<ClientContext, 'jobs'> & { jobs: IJobs }): void {
  ctx.effect(installWorkspaceReferenceStyle, 'workspace-chain: message reference style')
  ctx.effect(() => ctx.locale.register(DELEGATION_NS, { zh: delegationZh, en: delegationEn }), 'workspace-chain: delegation dictionaries')
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
  // This slot owns reference drops only in its current composer/conversation.
  // Capture the host's detect-coordinate selection and revision for every insert;
  // clipboard draft length is not an editor offset when chips already exist.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'workspace-chain-references', order: 30, locale: REFERENCE_NS },
    (props: PropsRuntime<'conversation.input.left'> & PropsLocale<typeof REFERENCE_NS>) => {
      const phase = props.useInput(state => state.phase)
      return <ReferenceDock items={references} sessionId={props.sessionId} t={props.t} disabled={phase !== 'plain'}
        insert={item => insertInputReference(props.inputActions, item)} />
    }))
  // Keyed toolview ownership is async (the catalog RPC decides the wire tool
  // name), while DSH's keyed dispatch falls back to the generic card for
  // unclaimed keys. A single failed catalog fetch would degrade every
  // delegation row to the plain generic card for the whole app session, so
  // armToolviewSlot retries with bounded backoff and re-arms on every
  // connection reset (initial connect, host restart, reconnect).
  ctx.slots.inject('conversation.session.jobs.kind', () => ctx.slots.register({
    name: 'conversation.session.jobs.kind', key: 'workspace-chain', locale: DELEGATION_NS,
  }, DelegationKind))
  ctx.slots.inject('tool.call.toolview', () => {
    const arm = armToolviewSlot({
      load,
      register: toolName => ctx.slots.register({
        name: 'tool.call.toolview', key: toolName, locale: DELEGATION_NS,
        inject: (): DelegationInjected => ({
          hooks: { delegationJobs: ctx.jobs.state },
          watchRows: sessionId => ctx.jobs.watchRows(sessionId),
          openSession: target => ctx.uiWorkspace.openSession(target),
        }),
      }, DelegationRow),
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