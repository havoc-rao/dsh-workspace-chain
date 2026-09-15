import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { CHANNEL, OWNER_ENDPOINT, type Catalog } from './shared/catalog.js'
import { workspaceTargets } from './workspace-hints.js'
import { ownersFor, type OwnerWorkspace, type OwnershipContext } from './ownership.js'
import type { ResolvedConfig } from './config.js'
import type {} from '@deepseek-ai/dsh-workspace'
export function mountCatalog(ctx: Context, config: ResolvedConfig): void {
  // Optional transport: headless hosts require no client services.
  ctx.inject(['connection'], scope => {
    const connection = scope.get('connection') as HostConnectionHandle
    const context = (): OwnershipContext => {
      const workspaces = (scope.get('workspaceRegistry')?.list() ?? []) as readonly OwnerWorkspace[]
      return { config, workspaces, nativeAvailable: scope.get('sessionController') !== undefined }
    }
    connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
      if (endpoint === 'catalog') {
        return { ok: true as const, value: { ...catalog(config), workspaces: workspaceList(context()) } }
      }
      if (endpoint === OWNER_ENDPOINT) {
        const body = payload as { path?: unknown; sessionId?: unknown } | undefined
        if (!body || typeof body.path !== 'string' || !body.path.trim()) {
          return { ok: false as const, error: { code: 'internal', message: 'ownerOf requires a non-empty path', details: {} } }
        }
        const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
        return { ok: true as const, value: ownersFor(context(), body.path, sessionId) }
      }
      return { ok: false as const, error: { code: 'internal', message: `Unknown workspace-chain endpoint: ${endpoint}`, details: {} } }
    }, { authority: 'loopback' })
  })
}
const catalog = (config: ResolvedConfig): Catalog => ({ toolName: config.toolName, targets: [...config.targets].map(([name, t]) => ({ name, purpose: t.purpose ?? '', aliases: t.aliases ?? [] })) })
function workspaceList(context: OwnershipContext): Catalog['workspaces'] {
  // Explicit projection: registry entities contain private records, logos and
  // membership lists. Never spread or serialize the entity itself.
  return context.workspaces.map(w => ({
    id: w.id,
    targets: workspaceTargets(w, context.config, context.nativeAvailable),
  }))
}