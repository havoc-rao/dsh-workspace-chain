export const CHANNEL = '/workspace-chain'
/** The RPC endpoint name answering "which registered workspace owns this path". */
export const OWNER_ENDPOINT = 'ownerOf'
export interface TargetSummary { name: string; purpose: string; aliases: string[] }
export interface Catalog { toolName: string; targets: TargetSummary[]; workspaces?: { id: string; targets: string[] }[] }
export function mention(name: string): string { return `@workspace/${encodeURIComponent(name)}` }
export function isCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== 'object') return false
  const obj = value as Catalog
  return (obj.workspaces === undefined || Array.isArray(obj.workspaces) && obj.workspaces.every(w => w && typeof w.id === 'string' && Array.isArray(w.targets) && w.targets.every(t => typeof t === 'string'))) && typeof obj.toolName === 'string' && Array.isArray(obj.targets) && obj.targets.every(t =>
    t && typeof t.name === 'string' && typeof t.purpose === 'string' && Array.isArray(t.aliases) && t.aliases.every(a => typeof a === 'string'))
}
/** One registered root (registry workspace or configured SDK target) containing an edit path. */
export interface PathOwnerView {
  kind: 'workspace' | 'target'
  /** Registry workspace id or configured target name. */
  id: string
  /** Display title (workspace) or target name. */
  name: string
  /** Canonical root path that contains the queried path. */
  root: string
  /** Whether a delegation can actually reach this owner (native session API or SDK executor). */
  delegatable: boolean
}
/** Answer of the ownerOf endpoint. */
export interface OwnerOfResult {
  /** Canonicalized query path (deepest existing ancestor resolution). */
  path: string
  /** Best-effort existence check on the canonical path. */
  exists: boolean
  /** The owner of the requesting session (its workspace), when resolvable. */
  current?: PathOwnerView
  /** Every registered root containing the path; the current owner included when it matches. */
  owners: PathOwnerView[]
}
export function isOwnerOfResult(value: unknown): value is OwnerOfResult {
  if (!value || typeof value !== 'object') return false
  const obj = value as OwnerOfResult
  const view = (v: unknown): v is PathOwnerView => v !== null && typeof v === 'object'
    && ((v as PathOwnerView).kind === 'workspace' || (v as PathOwnerView).kind === 'target')
    && typeof (v as PathOwnerView).id === 'string' && typeof (v as PathOwnerView).name === 'string'
    && typeof (v as PathOwnerView).root === 'string' && typeof (v as PathOwnerView).delegatable === 'boolean'
  return typeof obj.path === 'string' && typeof obj.exists === 'boolean'
    && (obj.current === undefined || view(obj.current))
    && Array.isArray(obj.owners) && obj.owners.every(view)
}
