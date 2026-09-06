import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CHANNEL, isCatalog } from '../shared/catalog.js'
import { createWorkspaceSource } from './source.js'
import { DelegationRow } from './DelegationRow.js'
export const inject = ['inputTriggers', 'connection', 'slots']
export function apply(ctx: ClientContext): void {
  const load = async () => {
    const connection = ctx.get('connection') as unknown as ConnectionHandle
    const result = await connection.rpc.call(CHANNEL, 'catalog', {})
    if (!result.ok) throw new Error(result.error.message)
    if (!isCatalog(result.value)) throw new Error('Invalid workspace-chain catalog')
    return result.value
  }
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => triggers.registerSource(createWorkspaceSource(load)), 'workspace-chain: target references')
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
}
