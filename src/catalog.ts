import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { CHANNEL, type Catalog } from './shared/catalog.js'
import { workspaceTargets } from './workspace-hints.js'
import type { ResolvedConfig } from './config.js'
import type {} from '@deepseek-ai/dsh-workspace'
export function mountCatalog(ctx: Context, config: ResolvedConfig): void {
  // Optional transport: headless hosts require no client services.
  ctx.inject(['connection'], scope => {
    const connection = scope.get('connection') as HostConnectionHandle
    const catalog: Catalog = { toolName: config.toolName, targets: [...config.targets].map(([name, t]) => ({ name, purpose: t.purpose ?? '', aliases: t.aliases ?? [] })) }
    connection.rpc.handle(CHANNEL, async endpoint => endpoint === 'catalog'
      ? { ok: true as const, value: { ...catalog, workspaces: (scope.get('workspaceRegistry')?.list() ?? []).map(w => ({ id: w.id, targets: workspaceTargets(w, config, scope.get('apiProxy') !== undefined) })) } }
      : { ok: false as const, error: { code: 'internal', message: `Unknown workspace-chain endpoint: ${endpoint}`, details: {} } }, { authority: 'loopback' })
  })
}
